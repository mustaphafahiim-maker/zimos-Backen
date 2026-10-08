'use strict';

const db = require('../../db/models');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { validatePageTree, EMPTY_TREE } = require('../pages/pageTree');

/**
 * Which starter template a website or funnel came from, and how many of each
 * there are (item 401, SPEC §9.1 "usage count on each template").
 *
 * A website records it in websites.source_template_version_id (since the
 * start) and a funnel in funnels.source_template_version_id (migration 531).
 * The count is taken live, not kept as a counter: the trash is a soft delete
 * that can be undone, a purge or a store deletion removes rows in bulk, and a
 * counter would have to follow every one of those. Live, a site or funnel in
 * the trash is simply not counted, and comes back with a restore.
 */

/** Map templateId → usesCount (websites + funnels not in the trash). */
async function usesCountsByTemplate(templateIds = null, { transaction } = {}) {
  if (Array.isArray(templateIds) && templateIds.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT tv.template_id AS "templateId", COUNT(*)::int AS "count"
       FROM (
         SELECT source_template_version_id AS version_id FROM websites
          WHERE source_template_version_id IS NOT NULL AND deleted_at IS NULL
         UNION ALL
         SELECT source_template_version_id FROM funnels
          WHERE source_template_version_id IS NOT NULL AND deleted_at IS NULL
       ) used
       JOIN template_versions tv ON tv.id = used.version_id
      ${Array.isArray(templateIds) ? 'WHERE tv.template_id IN (:templateIds)' : ''}
      GROUP BY tv.template_id`,
    { type: db.Sequelize.QueryTypes.SELECT, replacements: { templateIds }, transaction }
  );
  return new Map(rows.map((r) => [r.templateId, Number(r.count)]));
}

/** Map versionId → funnels built from it (not in the trash), beside templateService.websiteCountsFor. */
async function funnelCountsFor(versionIds, transaction) {
  if (versionIds.length === 0) return new Map();
  const rows = await db.Funnel.findAll({
    where: { sourceTemplateVersionId: versionIds },
    attributes: ['sourceTemplateVersionId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['sourceTemplateVersionId'],
    raw: true,
    transaction,
  });
  return new Map(rows.map((r) => [r.sourceTemplateVersionId, Number(r.count)]));
}

// A funnel is built from a funnel or landing template; a store template is a
// whole website (home, collection, product pages) and has no step to map to.
const FUNNEL_TEMPLATE_KINDS = ['funnel', 'landing'];

/** The active version a funnel is created from, checked like createWebsite checks its own. */
async function funnelTemplateVersion(templateVersionId, transaction) {
  const version = await db.TemplateVersion.findOne({
    where: { id: templateVersionId, isActive: true },
    include: [{ model: db.Template, as: 'template', attributes: ['id', 'kind'] }],
    transaction,
  });
  if (!version || !version.template) throw new NotFoundError('TemplateVersion');
  if (!FUNNEL_TEMPLATE_KINDS.includes(version.template.kind)) {
    throw new AppError('TEMPLATE_KIND_MISMATCH', 'This is a store template — pick a funnel or landing template', 422, [
      { field: 'templateVersionId', message: 'Pick a funnel or landing template' },
    ]);
  }
  return version;
}

function stepKeyFor(path, used) {
  const base =
    String(path || '/')
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 90) || 'home';
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
  used.add(key);
  return key;
}

/**
 * Copy the version's pages into the new funnel as steps. The first page (the
 * template's "/") is the landing step the visitor starts on; the rest become
 * generic pages (about, shipping, policies — off the map, at /p/<key>). No
 * links are made: the merchant draws them in the map editor, whose issues
 * list already says what is missing. Deep-copied, as createWebsite does, so
 * editing the template never reaches the funnel.
 */
async function seedFunnelSteps(workspaceId, funnelId, version, transaction) {
  const pages = Array.isArray(version.pages) ? version.pages : [];
  const used = new Set();
  const steps = [];
  for (const [i, page] of pages.entries()) {
    const key = stepKeyFor(page.path, used);
    const builderData = JSON.parse(JSON.stringify(page.builderData || EMPTY_TREE));
    validatePageTree(builderData, { label: `template page "${page.path || '/'}"` });
    steps.push(
      await db.FunnelStep.create(
        {
          workspaceId,
          funnelId,
          key,
          stepType: i === 0 ? 'landing' : 'custom',
          name: page.title || (i === 0 ? 'Landing' : key),
          builderData,
          seo: JSON.parse(JSON.stringify(page.seo || {})),
        },
        { transaction }
      )
    );
  }
  return steps;
}

module.exports = { usesCountsByTemplate, funnelCountsFor, funnelTemplateVersion, seedFunnelSteps, FUNNEL_TEMPLATE_KINDS };
