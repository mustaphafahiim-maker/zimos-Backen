'use strict';

const db = require('../../db/models');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { validatePageTree } = require('../pages/pageTree');

/**
 * Saved sections (SPEC §9.3): a section of a page kept in the workspace to be
 * used again — on every page and funnel (`scope: 'global'`) or inside one
 * funnel (`scope: 'funnel'`).
 *
 * Two ways to use one:
 *   - insert a copy: the page gets the section's nodes and no link back;
 *   - insert it linked: the page's section carries
 *     `settings.savedSectionId`, and when the website is published its rows
 *     and look are taken from the saved section — so editing the saved
 *     section and publishing changes every linked copy. "Detach" in the
 *     editor simply removes that setting.
 *
 * A saved section's `tree` is one ordinary section node and goes through the
 * same validator as a page, so nothing can be saved here that a page would
 * refuse.
 */

const MAX_SAVED_SECTIONS = 200;
const LINK_KEY = 'savedSectionId';

function assertSection(section) {
  // Reuses the page validator: one section, same node rules, same errors.
  validatePageTree({ version: 1, sections: [section] }, { label: 'saved section' });
  return section;
}

const present = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  scope: row.scope,
  funnelId: row.funnelId,
  tree: row.tree,
  updatedAt: row.updatedAt,
});

async function list(workspaceId, { funnelId } = {}) {
  const rows = await db.SavedSection.findAll({ where: { workspaceId }, order: [['name', 'ASC']] });
  // Global sections always; a funnel's own only when that funnel is named.
  return rows.filter((r) => r.scope === 'global' || (funnelId && r.funnelId === funnelId)).map(present);
}

async function load(workspaceId, id) {
  const row = await db.SavedSection.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Saved section');
  return row;
}

async function create(workspaceId, { name, type, scope, funnelId, section }, req) {
  assertSection(section);
  if (scope === 'funnel') {
    const funnel = funnelId ? await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['id'] }) : null;
    if (!funnel) throw new ValidationError([{ field: 'funnelId', message: 'A funnel-scoped section needs a funnel of this store' }]);
  }
  if ((await db.SavedSection.count({ where: { workspaceId } })) >= MAX_SAVED_SECTIONS) {
    throw new ValidationError([{ field: 'name', message: `A store can keep at most ${MAX_SAVED_SECTIONS} saved sections` }]);
  }
  const row = await db.SavedSection.create({
    workspaceId,
    name,
    type: type || null,
    scope: scope === 'funnel' ? 'funnel' : 'global',
    funnelId: scope === 'funnel' ? funnelId : null,
    tree: section,
    createdBy: req.user.id,
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'saved_section.create',
    entityType: 'SavedSection',
    entityId: row.id,
    after: { name: row.name, scope: row.scope },
    req,
  });
  return present(row);
}

async function update(workspaceId, id, { name, type, section }, req) {
  const row = await load(workspaceId, id);
  const before = { name: row.name, type: row.type };
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (type !== undefined) patch.type = type || null;
  if (section !== undefined) patch.tree = assertSection(section);
  await row.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'saved_section.update',
    entityType: 'SavedSection',
    entityId: row.id,
    before,
    after: { name: row.name, type: row.type, contentChanged: section !== undefined },
    req,
  });
  return present(row);
}

async function remove(workspaceId, id, req) {
  const row = await load(workspaceId, id);
  await row.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'saved_section.delete',
    entityType: 'SavedSection',
    entityId: id,
    before: { name: row.name, scope: row.scope },
    req,
  });
  return { deleted: true, id };
}

/**
 * A page tree with its linked sections filled in from the saved ones — what
 * a publish freezes into the snapshot. A linked section keeps its own id (so
 * anchors and analytics stay put) and its link; its rows and look come from
 * the saved section. A link to a section that was deleted leaves the page's
 * own copy as it is.
 */
async function resolveLinkedSections(workspaceId, tree, { transaction, stampCountdowns = false } = {}) {
  const sections = tree && Array.isArray(tree.sections) ? tree.sections : null;
  if (!sections) return tree;
  const ids = [
    ...new Set(
      sections
        .map((s) => (s && s.settings && typeof s.settings[LINK_KEY] === 'string' ? s.settings[LINK_KEY] : null))
        .filter(Boolean)
    ),
  ];
  if (ids.length === 0) return tree;
  const rows = await db.SavedSection.findAll({ where: { workspaceId, id: ids }, transaction });
  if (stampCountdowns) {
    // Going live: a countdown's "N hours" becomes a date in the saved section itself, so
    // every page linking it, and every later publish, shows the same deadline (pages/countdownDeadline.js).
    for (const row of rows) {
      const stamped = require('../pages/countdownDeadline').stampCountdowns({ sections: [row.tree] });
      if (stamped.changed) await row.update({ tree: stamped.tree.sections[0] }, { transaction });
    }
  }
  const saved = new Map(rows.map((r) => [r.id, r.tree]));
  return {
    ...tree,
    sections: sections.map((section) => {
      const source = section && section.settings ? saved.get(section.settings[LINK_KEY]) : null;
      if (!source) return section;
      return {
        ...source,
        id: section.id,
        type: 'section',
        settings: { ...(source.settings || {}), [LINK_KEY]: section.settings[LINK_KEY] },
      };
    }),
  };
}

module.exports = { list, create, update, remove, resolveLinkedSections, SAVED_SECTION_LINK_KEY: LINK_KEY };
