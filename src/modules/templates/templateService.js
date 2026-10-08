'use strict';

const db = require('../../db/models');
const { NotFoundError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { validatePageTree } = require('../pages/pageTree');
const { usesCountsByTemplate, funnelCountsFor } = require('./templateUsage');

// The "current" version of a template = the highest `version` number that is
// still active. A published template with no active version is not offered.
async function latestActiveVersion(templateId, transaction) {
  return db.TemplateVersion.findOne({
    where: { templateId, isActive: true },
    order: [['version', 'DESC']],
    ...(transaction ? { transaction } : {}),
  });
}

// The card the gallery grid renders. `primaryColor` falls back to the active
// version's globalStyles, so a template whose denormalized column was never
// filled in still paints the right swatch. `priceAmount` is a BIGINT column,
// which pg hands back as a string — the API emits it as a number.
function toGalleryCard(template, version, usesCount = 0) {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    thumbnailUrl: template.thumbnailUrl,
    kind: template.kind,
    priceAmount: Number(template.priceAmount),
    isFree: template.isFree,
    primaryColor: template.primaryColor || (version.globalStyles || {}).primaryColor || null,
    tags: template.tags || [],
    rtl: template.rtl,
    templateVersionId: version.id,
    // Websites and funnels made from it, not counting the trash (templateUsage.js).
    usesCount,
    createdAt: template.createdAt,
  };
}

// Gallery sorts (SPEC §9.1 "sorting by newest or most used"). `name` is the
// order the picker has always opened on, so it stays the default.
const GALLERY_SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  newest: (a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name),
  most_used: (a, b) => b.usesCount - a.usesCount || a.name.localeCompare(b.name),
};

// Language → text direction. A template has no language column, only `rtl`
// (its Arabic version reads right to left), so that is what the filter reads.
const RTL_LANGUAGES = new Set(['ar']);

/**
 * The public gallery. `kind` is the tab (store / funnel / landing; absent =
 * the whole grid, which is what the picker opens on); `category`, `price`
 * (free | paid, from the stored isFree flag), `rtl` and `language` narrow
 * it; `sort` is name | newest | most_used. `categories` lists every category
 * of the published grid for the current tab, so the chips don't vanish as the
 * other filters narrow the cards.
 */
async function listPublishedTemplates({ kind, category, price, rtl, language, sort = 'name' } = {}) {
  const where = { isPublished: true, ...(kind ? { kind } : {}) };
  const tabTemplates = await db.Template.findAll({ where, order: [['name', 'ASC']] });

  const wantRtl = rtl !== undefined ? rtl : language ? RTL_LANGUAGES.has(language) : undefined;
  const conflicting = rtl !== undefined && language && RTL_LANGUAGES.has(language) !== rtl;
  const templates = conflicting
    ? []
    : tabTemplates.filter(
        (t) =>
          (!category || t.category === category) &&
          (!price || t.isFree === (price === 'free')) &&
          (wantRtl === undefined || t.rtl === wantRtl)
      );

  const counts = await usesCountsByTemplate(templates.map((t) => t.id));
  const out = [];
  for (const t of templates) {
    const version = await latestActiveVersion(t.id);
    if (!version) continue;
    out.push(toGalleryCard(t, version, counts.get(t.id) || 0));
  }
  out.sort(GALLERY_SORTS[sort] || GALLERY_SORTS.name);
  const categories = [...new Set(tabTemplates.map((t) => t.category).filter(Boolean))].sort();
  return { templates: out, categories };
}

async function getTemplateDetail(id) {
  const template = await db.Template.findOne({ where: { id, isPublished: true } });
  if (!template) throw new NotFoundError('Template');

  const version = await latestActiveVersion(id);
  if (!version) throw new NotFoundError('Template');

  const counts = await usesCountsByTemplate([template.id]);
  return {
    ...toGalleryCard(template, version, counts.get(template.id) || 0),
    isPublished: template.isPublished,
    version: version.version,
    globalStyles: version.globalStyles,
    pages: version.pages,
    sections: version.sections,
  };
}

// ------------------------------------------------------------------- admin
// The write side of the gallery, driven by /api/v1/admin/templates. Kept in
// this module rather than platformAdmin's so one file owns what a Template
// row means; the admin routes only supply the platform-admin guard.

// The columns the editor owns. Version content (pages, sections, styles) is
// deliberately not here: a version is the immutable thing a merchant's site is
// copied from, and it is authored, not edited in a metadata form.
const EDITABLE = ['name', 'category', 'thumbnailUrl', 'isPublished', 'kind', 'priceAmount', 'isFree', 'primaryColor', 'tags', 'rtl'];

// Nullable text columns. A form clears one by sending "", which has to land as
// NULL so the gallery's "no value — fall back" branches still fire.
const NULLABLE_TEXT = new Set(['category', 'thumbnailUrl', 'primaryColor']);

/**
 * The admin grid's row. Two things separate it from the public gallery card:
 *
 * - `primaryColor` is the raw column, with no fallback to the version's
 *   globalStyles. The card resolves it for display; the editor must not, or
 *   saving the form back would freeze an inherited colour into the column.
 * - `versionCount` / `activeVersion` exist because the public list silently
 *   drops a template with no active version. Without them a published
 *   template that never appears in the gallery has no visible explanation.
 */
function toAdminRow(template, versions = [], usesCount = 0) {
  const active = versions.find((v) => v.isActive) || null;
  return {
    // Exactly the public gallery's rule (listPublishedTemplates): published
    // AND an active version. What a merchant sees, stated rather than implied.
    inGallery: Boolean(template.isPublished && active),
    id: template.id,
    name: template.name,
    category: template.category,
    thumbnailUrl: template.thumbnailUrl,
    isPublished: template.isPublished,
    kind: template.kind,
    priceAmount: Number(template.priceAmount),
    isFree: template.isFree,
    primaryColor: template.primaryColor,
    tags: template.tags || [],
    rtl: template.rtl,
    versionCount: versions.length,
    activeVersion: active ? active.version : null,
    templateVersionId: active ? active.id : null,
    // Websites and funnels made from any of its versions, not counting the trash — the gallery's number.
    usesCount,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

// Newest-first: the row an admin just created is the one they want to see.
const ADMIN_ORDER = [['createdAt', 'DESC']];
// Newest version first, so the first active entry found is the current one.
const VERSION_ORDER = [['version', 'DESC']];

async function listAllTemplates({ kind } = {}) {
  const templates = await db.Template.findAll({
    where: kind ? { kind } : undefined,
    order: ADMIN_ORDER,
  });
  if (templates.length === 0) return [];

  // One query for every version rather than one per template: this list is the
  // whole library, drafts included, so it is the longest loop in the module.
  const versions = await db.TemplateVersion.findAll({
    where: { templateId: templates.map((t) => t.id) },
    order: VERSION_ORDER,
  });
  const byTemplate = new Map();
  for (const v of versions) {
    if (!byTemplate.has(v.templateId)) byTemplate.set(v.templateId, []);
    byTemplate.get(v.templateId).push(v);
  }
  const counts = await usesCountsByTemplate(templates.map((t) => t.id));
  return templates.map((t) => toAdminRow(t, byTemplate.get(t.id) || [], counts.get(t.id) || 0));
}

async function usesOf(templateId, transaction) {
  return (await usesCountsByTemplate([templateId], { transaction })).get(templateId) || 0;
}

function versionsOf(templateId, transaction) {
  return db.TemplateVersion.findAll({ where: { templateId }, order: VERSION_ORDER, transaction });
}

// What an audit row records about a template: the editable columns.
function templateAuditState(template) {
  const out = {};
  for (const key of EDITABLE) out[key] = key === 'priceAmount' ? Number(template[key]) : template[key];
  return out;
}

// Every admin write is audited as a platform-level entry (workspace_id NULL).
// `req` is absent only for a direct service call (a script or a seeder),
// which has no actor to record.
async function audit(req, fields, transaction) {
  if (!req) return;
  await recordAudit({ actorUserId: req.user ? req.user.id : null, req, transaction, ...fields });
}

/** Create (no `id`) or update (with `id`). The update is partial — only keys
 *  actually present are written, so a grid that toggles one switch cannot
 *  blank out the fields its form never loaded. */
async function saveTemplate(input, req = null) {
  const fields = {};
  for (const key of EDITABLE) {
    if (input[key] === undefined) continue;
    fields[key] = NULLABLE_TEXT.has(key) && input[key] === '' ? null : input[key];
  }

  return db.sequelize.transaction(async (transaction) => {
    const template = input.id
      ? await db.Template.findByPk(input.id, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    if (input.id && !template) throw new NotFoundError('Template');

    // A template being created has no versions yet, which is exactly why the
    // guard below applies to it too: nothing can be born published.
    const versions = template ? await versionsOf(template.id, transaction) : [];

    // Publishing a template with no active version puts it nowhere: the gallery
    // drops it on the way out. Refuse loudly instead of leaving the console
    // showing "published" next to a template that never appears.
    if (fields.isPublished === true && !versions.some((v) => v.isActive)) {
      throw new ConflictError(
        'This template has no active version yet, so publishing it would hide it from the gallery',
        'TEMPLATE_HAS_NO_ACTIVE_VERSION'
      );
    }

    if (!template) {
      const created = await db.Template.create(fields, { transaction });
      await audit(
        req,
        { action: 'template.create', entityType: 'Template', entityId: created.id, after: templateAuditState(created) },
        transaction
      );
      return toAdminRow(created, []);
    }

    const before = templateAuditState(template);
    await template.update(fields, { transaction });
    await audit(
      req,
      { action: 'template.update', entityType: 'Template', entityId: template.id, before, after: templateAuditState(template) },
      transaction
    );
    return toAdminRow(template, versions, await usesOf(template.id, transaction));
  });
}

/**
 * POST /admin/templates/:id/publish and /unpublish. Same guard as the PATCH:
 * publishing needs an active version. Idempotent — a template already in the
 * requested state comes back unchanged, with no audit row.
 */
async function setPublished(id, isPublished, req = null) {
  return db.sequelize.transaction(async (transaction) => {
    const template = await db.Template.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!template) throw new NotFoundError('Template');
    const versions = await versionsOf(id, transaction);
    if (template.isPublished === isPublished) return toAdminRow(template, versions, await usesOf(id, transaction));

    if (isPublished && !versions.some((v) => v.isActive)) {
      throw new ConflictError(
        'This template has no active version yet, so publishing it would hide it from the gallery',
        'TEMPLATE_HAS_NO_ACTIVE_VERSION'
      );
    }
    await template.update({ isPublished }, { transaction });
    await audit(
      req,
      {
        action: isPublished ? 'template.publish' : 'template.unpublish',
        entityType: 'Template',
        entityId: template.id,
        before: { isPublished: !isPublished },
        after: { isPublished },
      },
      transaction
    );
    return toAdminRow(template, versions, await usesOf(id, transaction));
  });
}

async function deleteTemplate(id, req = null) {
  return db.sequelize.transaction(async (transaction) => {
    const template = await db.Template.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!template) throw new NotFoundError('Template');

    const versions = await versionsOf(id, transaction);
    if (versions.length > 0) {
      // websites.source_template_version_id is ON DELETE SET NULL, so the
      // database would let this through and quietly cut every affected site
      // loose from the template it came from. This guard is the only thing
      // keeping that provenance.
      const built = {
        where: { sourceTemplateVersionId: versions.map((v) => v.id) },
        transaction,
        paranoid: false, // a site or funnel in the trash can still be restored
      };
      // Funnels made from a funnel or landing template (migration 531) keep the same link.
      const inUse = (await db.Website.count(built)) + (await db.Funnel.count(built));
      if (inUse > 0) {
        throw new ConflictError(
          `${inUse} website(s) or funnel(s) were created from this template — unpublish it instead`,
          'TEMPLATE_IN_USE'
        );
      }
    }

    const before = { ...templateAuditState(template), versionCount: versions.length };
    // template_versions.template_id is ON DELETE CASCADE, so the versions go
    // with it; nothing was built from them, per the check above.
    await template.destroy({ transaction });
    await audit(req, { action: 'template.delete', entityType: 'Template', entityId: id, before }, transaction);
    return { success: true };
  });
}

// ---------------------------------------------------------------- versions
// A version is immutable once written: websites are deep-copied from it and
// keep `source_template_version_id` pointing back. So the admin surface can
// add a version and switch versions on or off, never edit one in place.
// The gallery offers the highest-numbered ACTIVE version (latestActiveVersion).

/** A version without its content — the list the editor shows. */
function toVersionSummary(version, websiteCounts = new Map(), funnelCounts = new Map()) {
  return {
    id: version.id,
    version: version.version,
    isActive: version.isActive,
    pageCount: Array.isArray(version.pages) ? version.pages.length : 0,
    pagePaths: Array.isArray(version.pages) ? version.pages.map((pg) => pg.path || '/') : [],
    sectionCount: Array.isArray(version.sections) ? version.sections.length : 0,
    primaryColor: (version.globalStyles || {}).primaryColor || null,
    websiteCount: websiteCounts.get(version.id) || 0,
    funnelCount: funnelCounts.get(version.id) || 0,
    createdAt: version.createdAt,
  };
}

async function websiteCountsFor(versionIds, transaction) {
  if (versionIds.length === 0) return new Map();
  const rows = await db.Website.findAll({
    where: { sourceTemplateVersionId: versionIds },
    attributes: ['sourceTemplateVersionId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['sourceTemplateVersionId'],
    raw: true,
    transaction,
  });
  return new Map(rows.map((r) => [r.sourceTemplateVersionId, Number(r.count)]));
}

/** GET /admin/templates/:id — the admin row plus every version, newest first. */
async function getTemplateForAdmin(id) {
  const template = await db.Template.findByPk(id);
  if (!template) throw new NotFoundError('Template');
  const versions = await versionsOf(id);
  const ids = versions.map((v) => v.id);
  const [counts, funnels, uses] = await Promise.all([websiteCountsFor(ids), funnelCountsFor(ids), usesCountsByTemplate([id])]);
  return {
    template: toAdminRow(template, versions, uses.get(id) || 0),
    versions: versions.map((v) => toVersionSummary(v, counts, funnels)),
  };
}

/** GET /admin/templates/:id/versions/:versionId — one version with its content. */
async function getVersionForAdmin(templateId, versionId) {
  const version = await db.TemplateVersion.findOne({ where: { id: versionId, templateId } });
  if (!version) throw new NotFoundError('Template version');
  const counts = await websiteCountsFor([version.id]);
  return {
    ...toVersionSummary(version, counts, await funnelCountsFor([version.id])),
    globalStyles: version.globalStyles,
    pages: version.pages,
    sections: version.sections,
  };
}

/**
 * Every page must survive the copy a merchant's "use this template" makes
 * (pagesService.createWebsite): the same tree validator runs here, so a
 * version that would fail there is refused when it is written instead. Paths
 * must be unique once normalized, as they are on a website.
 */
function validateVersionPages(pages) {
  const seen = new Set();
  pages.forEach((page, i) => {
    const path = String(page.path || '/').trim().toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1') || '/';
    if (seen.has(path)) {
      throw new ValidationError([{ field: `pages[${i}].path`, message: `Two pages use the path "${path}"` }]);
    }
    seen.add(path);
    if (page.builderData !== undefined) validatePageTree(page.builderData, { label: `template page "${path}"` });
  });
}

/**
 * POST /admin/templates/:id/versions — the next version number, written
 * whole. `activate` (default true) makes it the one the gallery offers;
 * earlier versions stay as they are (still active ones remain selectable by
 * id, exactly as before).
 */
async function createVersion(templateId, input, req = null) {
  validateVersionPages(input.pages);
  return db.sequelize.transaction(async (transaction) => {
    // Locks the template so two admins adding a version at once get
    // consecutive numbers instead of one of them hitting the unique index.
    const template = await db.Template.findByPk(templateId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!template) throw new NotFoundError('Template');

    const latest = await db.TemplateVersion.max('version', { where: { templateId }, transaction });
    const version = await db.TemplateVersion.create(
      {
        templateId,
        version: (latest || 0) + 1,
        globalStyles: input.globalStyles,
        pages: input.pages,
        sections: input.sections,
        isActive: input.activate !== false,
      },
      { transaction }
    );
    await audit(
      req,
      {
        action: 'template_version.create',
        entityType: 'TemplateVersion',
        entityId: version.id,
        after: { templateId, version: version.version, isActive: version.isActive, pageCount: input.pages.length },
      },
      transaction
    );
    return toVersionSummary(version);
  });
}

/**
 * PATCH /admin/templates/:id/versions/:versionId { isActive }. Switching off
 * the last active version of a PUBLISHED template is refused: the gallery
 * would silently stop listing it while the console still says "published".
 * Unpublish first, or activate another version.
 */
async function setVersionActive(templateId, versionId, isActive, req = null) {
  return db.sequelize.transaction(async (transaction) => {
    const template = await db.Template.findByPk(templateId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!template) throw new NotFoundError('Template');
    const versions = await versionsOf(templateId, transaction);
    const version = versions.find((v) => v.id === versionId);
    if (!version) throw new NotFoundError('Template version');
    if (version.isActive === isActive) return toVersionSummary(version, await websiteCountsFor([version.id], transaction), await funnelCountsFor([version.id], transaction));

    if (!isActive && template.isPublished && versions.filter((v) => v.isActive).length === 1) {
      throw new ConflictError(
        'This is the only active version of a published template — deactivating it would hide the template from the gallery. Unpublish it first, or activate another version.',
        'TEMPLATE_NEEDS_ACTIVE_VERSION'
      );
    }

    await version.update({ isActive }, { transaction });
    await audit(
      req,
      {
        action: isActive ? 'template_version.activate' : 'template_version.deactivate',
        entityType: 'TemplateVersion',
        entityId: version.id,
        before: { isActive: !isActive },
        after: { isActive },
        metadata: { templateId, version: version.version },
      },
      transaction
    );
    return toVersionSummary(version, await websiteCountsFor([version.id], transaction), await funnelCountsFor([version.id], transaction));
  });
}

module.exports = {
  listPublishedTemplates,
  getTemplateDetail,
  latestActiveVersion,
  listAllTemplates,
  saveTemplate,
  setPublished,
  deleteTemplate,
  getTemplateForAdmin,
  getVersionForAdmin,
  createVersion,
  setVersionActive,
};
