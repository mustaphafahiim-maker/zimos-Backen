'use strict';

const asyncHandler = require('express-async-handler');
const Joi = require('joi');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/**
 * A funnel's generic pages (SPEC §9.2: "contact us, about us, policies — in a
 * sidebar, not on the map"): a `custom` step with no edge in or out. Such a
 * step is not part of the path — it is never the entry and is not required
 * to be reachable (funnelGraph.js) — and a visitor opens it by its own
 * address, from any link on the funnel's pages:
 *
 *   GET /store/:ws/funnels/:funnelRef/pages            → the generic pages { key, name }
 *   GET /store/:ws/funnels/:funnelRef/pages/:stepKey   → one, as a step is served
 *                                                       (also by an address it had before)
 *
 * Both read the published revision only. A `custom` step joined to the map by
 * an edge is an ordinary step, as before.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A custom step no edge touches. */
function isGeneric(step, edges) {
  if (!step || step.stepType !== 'custom') return false;
  return !(edges || []).some((e) => e.fromStepKey === step.key || e.toStepKey === step.key);
}

/** The steps that make up the path; all of them when every step is generic (a one-page funnel). */
function flowSteps(steps, edges) {
  const flow = (steps || []).filter((s) => !isGeneric(s, edges));
  return flow.length > 0 ? flow : steps || [];
}

const notFound = () => new AppError('FUNNEL_PAGE_NOT_FOUND', 'Page not found', 404);

async function published(workspaceId, funnelRef) {
  const where = { workspaceId, status: 'published' };
  if (UUID_RE.test(funnelRef)) where.id = funnelRef;
  else where.subdomain = funnelRef;
  const funnel = await db.Funnel.findOne({ where });
  if (!funnel || !funnel.publishedRevisionId) throw notFound();
  const revision = await db.FunnelRevision.findOne({ where: { id: funnel.publishedRevisionId, funnelId: funnel.id } });
  if (!revision) throw notFound();
  const snapshot = revision.snapshot || {};
  const pages = (snapshot.steps || []).filter((s) => isGeneric(s, snapshot.edges));
  return { funnel, snapshot, pages };
}

const funnelView = (funnel) => ({
  id: funnel.id,
  name: funnel.name,
  subdomain: funnel.subdomain,
  settings: require('./geoRedirects').resolveSettings(funnel),
});

const schemas = {
  list: { params: Joi.object({ workspaceId: Joi.string().required(), funnelRef: Joi.string().max(100).required() }) },
  one: {
    params: Joi.object({
      workspaceId: Joi.string().required(),
      funnelRef: Joi.string().max(100).required(),
      stepKey: Joi.string().max(100).required(),
    }),
  },
};

const list = asyncHandler(async (req, res) => {
  const { funnel, pages } = await published(req.tenant.workspaceId, req.params.funnelRef);
  res.json({ funnel: funnelView(funnel), pages: pages.map((s) => ({ key: s.key, name: s.name })) });
});

const one = asyncHandler(async (req, res) => {
  const { funnel, pages } = await published(req.tenant.workspaceId, req.params.funnelRef);
  // An address the page had before it was renamed still opens it; `step.key` is where it lives now (genericPageAddress.js).
  const step = pages.find((s) => s.key === req.params.stepKey) || require('./genericPageAddress').findMoved(pages, req.params.stepKey);
  if (!step) throw notFound();
  const payload = {
    funnel: funnelView(funnel),
    step: { id: step.id || null, key: step.key, name: step.name, stepType: step.stepType, tree: step.builderData, seo: step.seo || {} },
    pages: pages.map((s) => ({ key: s.key, name: s.name })),
  };
  // In the shopper's language, with its scripts and HTML blocks, as a step on the path is.
  res.json(await require('./funnelsController').localizeStep(req, funnel.id, payload));
});

module.exports = { isGeneric, flowSteps, schemas, list, one };
