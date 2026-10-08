'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { storefrontPostLimiters } = require('../../core/middleware/rateLimiters');

/*
 * Storefront search analytics and synonyms (spec-gaps item 211).
 *
 * - Every search's first page is logged (query lower-cased and trimmed, result
 *   count) and the listing answers with a `searchId`; the storefront reports
 *   the result the shopper opens (POST /store/:ws/search/click). No personal
 *   data: the visitor id only, to count shoppers.
 * - settings.search_synonyms = [["تيشيرت", "tshirt", "t-shirt"], …]: when a
 *   search finds nothing and its words are one of a group's terms, the other
 *   terms are tried in order and the first with results is served
 *   (`servedAs`). Plain words keep their own results.
 * - The merchant's report: top searches, searches with no results, results
 *   opened and the click-through rate, over a period.
 */

const norm = (q) => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);

function synonymsOf(workspace) {
  const groups = (workspace && workspace.settings && Array.isArray(workspace.settings.search_synonyms) && workspace.settings.search_synonyms) || [];
  return groups.filter((g) => Array.isArray(g) && g.length > 1);
}

/** storefrontService.listProducts: the search, or a synonym's results when it found nothing. */
async function searchWithSynonyms(workspaceId, query, run) {
  const result = await run(query);
  if (!query.search || (result && result.total > 0)) return result;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const q = norm(query.search);
  const group = synonymsOf(workspace).find((g) => g.some((t) => norm(t) === q));
  if (!group) return result;
  for (const term of group.filter((t) => norm(t) !== q)) {
    const alt = await run({ ...query, search: term });
    if (alt && alt.total > 0) return { ...alt, servedAs: term };
  }
  return result;
}

/** The listing controller: logs a first-page search; returns its id (null when not logged). */
async function record(workspaceId, query, result, visitorId) {
  try {
    if (!query.search || (query.page && Number(query.page) > 1) || query.cursor) return null;
    const row = await db.sequelize.query(
      'INSERT INTO search_queries (workspace_id, query, results_count, served_as, visitor_id) VALUES (:ws, :q, :n, :served, :visitor) RETURNING id',
      { replacements: { ws: workspaceId, q: norm(query.search), n: Number(result && result.total) || 0, served: result && result.servedAs ? norm(result.servedAs) : null, visitor: visitorId ? String(visitorId).slice(0, 64) : null }, type: QueryTypes.SELECT }
    );
    return row[0].id;
  } catch (err) {
    logger.warn(`[searchInsights] not logged: ${err.message}`);
    return null;
  }
}

async function report(workspaceId, { from, to }) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 864e5);
  const r = { ws: workspaceId, start, end };
  const q = (sql) => db.sequelize.query(sql, { replacements: r, type: QueryTypes.SELECT });
  const where = 'workspace_id = :ws AND created_at >= :start AND created_at < :end';
  const [[totals], top, zero, clicked] = await Promise.all([
    q(`SELECT COUNT(*)::int AS searches, COUNT(DISTINCT visitor_id)::int AS searchers, COUNT(*) FILTER (WHERE results_count = 0)::int AS "noResults", COUNT(clicked_at)::int AS clicks FROM search_queries WHERE ${where}`),
    q(`SELECT query, COUNT(*)::int AS searches, ROUND(AVG(results_count))::int AS "avgResults", COUNT(clicked_at)::int AS clicks, MAX(served_as) AS "servedAs" FROM search_queries WHERE ${where} GROUP BY query ORDER BY searches DESC, query LIMIT 50`),
    q(`SELECT query, COUNT(*)::int AS searches, MAX(created_at) AS "lastAt" FROM search_queries WHERE ${where} AND results_count = 0 GROUP BY query ORDER BY searches DESC, query LIMIT 50`),
    q(`SELECT s.clicked_product_id AS "productId", p.name, COUNT(*)::int AS clicks FROM search_queries s JOIN products p ON p.id = s.clicked_product_id WHERE s.workspace_id = :ws AND s.created_at >= :start AND s.created_at < :end GROUP BY 1, 2 ORDER BY clicks DESC LIMIT 20`),
  ]);
  const ctr = (c, n) => (n ? Math.round((c / n) * 1000) / 10 : null);
  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    totals: { ...totals, clickRate: ctr(totals.clicks, totals.searches - totals.noResults) },
    topSearches: top.map((t) => ({ ...t, clickRate: ctr(t.clicks, t.searches) })),
    noResults: zero,
    topClickedProducts: clicked,
  };
}

/** Daily: entries older than 180 days go. */
async function prune() {
  await db.sequelize.query("DELETE FROM search_queries WHERE created_at < NOW() - INTERVAL '180 days'");
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/store/:workspaceId/search — the result the shopper opened.
const store = Router({ mergeParams: true });
store.post(
  '/click',
  storefrontPostLimiters.searchClick,
  resolvePublicWorkspace,
  validate({ params: Joi.object({ workspaceId: Joi.string().required() }), body: Joi.object({ searchId: Joi.string().uuid().required(), productId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    // The first click counts; only within the hour of the search.
    await db.sequelize.query(
      "UPDATE search_queries SET clicked_product_id = :p, clicked_at = NOW() WHERE id = :id AND workspace_id = :ws AND clicked_at IS NULL AND created_at > NOW() - INTERVAL '1 hour' AND EXISTS (SELECT 1 FROM products WHERE id = :p AND workspace_id = :ws)",
      { replacements: { p: req.body.productId, id: req.body.searchId, ws: req.publicWorkspace.id } }
    );
    res.status(204).end();
  })
);

// Mounted at /api/v1/workspaces/:workspaceId/search-insights.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: ws, query: Joi.object({ from: Joi.date().iso(), to: Joi.date().iso() }) }), asyncHandler(async (req, res) => res.json(await report(req.tenant.workspaceId, req.query))));
staff.get('/synonyms', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => {
  res.json({ groups: synonymsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] })) });
}));
staff.put(
  '/synonyms',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ params: ws, body: Joi.object({ groups: Joi.array().items(Joi.array().items(Joi.string().trim().min(1).max(60)).min(2).max(10)).max(200).required() }) }),
  asyncHandler(async (req, res) => {
    const groups = req.body.groups.map((g) => [...new Set(g.map((t) => t.trim()))]).filter((g) => g.length > 1);
    const seen = new Set();
    for (const t of groups.flat().map(norm)) {
      if (seen.has(t)) throw new ValidationError([{ field: 'groups', message: `"${t}" is in two groups` }]);
      seen.add(t);
    }
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    await workspace.update({ settings: { ...(workspace.settings || {}), search_synonyms: groups } });
    require('../storefront/storefrontCache').invalidate(workspace.id);
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'search_synonyms.update', entityType: 'Workspace', entityId: workspace.id, after: { groups: groups.length }, req });
    res.json({ groups });
  })
);

module.exports = { store, staff, searchWithSynonyms, record, report, prune };
