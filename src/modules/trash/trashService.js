'use strict';

const db = require('../../db/models');
const { NotFoundError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PERMISSIONS } = require('../../core/security/permissions');
const logger = require('../../core/utils/logger');

const Op = db.Sequelize.Op;

/**
 * The trash (item 373, Lightfunnels parity). Deleting a funnel, a website or
 * a page no longer removes it: the row gets deleted_at (the models are
 * paranoid, so every lookup in the code skips it from then on, the public
 * runtime included) and keeps everything hanging off it: a funnel's steps,
 * edges, revisions and sessions, a website's pages, revisions, redirects and
 * domains. Orders keep their funnel_id, and analytics events theirs.
 *
 *   restore  puts it back exactly as it was (a published funnel is live
 *            again at once; a page needs its website out of the trash)
 *   purge    deletes it for good, as the old delete did; a purged funnel's
 *            name is written on its orders (orders.funnel_name) first, and a
 *            purged website's domains move to another website of the store
 *   sweep    purges whatever has sat in the trash for RETENTION_DAYS
 *
 * A trashed row still holds its subdomain (funnels, websites) or its path
 * (pages), so the restore can never collide.
 */

const RETENTION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const KINDS = {
  funnel: { model: () => db.Funnel, permission: PERMISSIONS.FUNNELS_MANAGE, entityType: 'Funnel', action: 'funnel' },
  website: { model: () => db.Website, permission: PERMISSIONS.WEBSITE_EDIT, entityType: 'Website', action: 'website' },
  page: { model: () => db.WebsitePage, permission: PERMISSIONS.WEBSITE_EDIT, entityType: 'WebsitePage', action: 'page' },
};
const KIND_NAMES = Object.keys(KINDS);

const purgeAt = (deletedAt) => (deletedAt ? new Date(new Date(deletedAt).getTime() + RETENTION_DAYS * DAY) : null);

/**
 * Moves a loaded funnel, website or page to the trash (its delete endpoint).
 * Returns what the delete answers beside { deleted: true }.
 */
async function moveToTrash(row, req, transaction) {
  const Model = row.constructor;
  const run = async (t) => {
    await Model.update({ deletedBy: req && req.user ? req.user.id : null }, { where: { id: row.id }, hooks: false, transaction: t });
    await row.destroy({ transaction: t });
  };
  if (transaction) await run(transaction);
  else await db.sequelize.transaction(run);
  return { trashed: true, purgeAt: purgeAt(row.deletedAt || new Date()) };
}

async function loadTrashed(workspaceId, kind, id, transaction) {
  const spec = KINDS[kind];
  const row = await spec.model().findOne({
    where: { id, workspaceId, deletedAt: { [Op.ne]: null } },
    paranoid: false,
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!row) throw new NotFoundError(`${spec.entityType} in the trash`);
  return row;
}

function present(kind, row, users, websites) {
  const base = {
    kind,
    id: row.id,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy ? users.get(row.deletedBy) || { id: row.deletedBy, fullName: null } : null,
    purgeAt: purgeAt(row.deletedAt),
  };
  if (kind === 'funnel') return { ...base, name: row.name, subdomain: row.subdomain, status: row.status };
  if (kind === 'website') return { ...base, name: row.name, subdomain: row.subdomain, status: row.status };
  const site = websites.get(row.websiteId);
  return {
    ...base,
    name: row.title,
    path: row.path,
    websiteId: row.websiteId,
    websiteName: site ? site.name : null,
    // Restore the website first: a page can only come back into a website that is out of the trash.
    websiteInTrash: Boolean(site && site.deletedAt),
    wasLive: row.publishedData != null,
  };
}

/** The kinds this teammate may see in the trash (funnels.manage, website.edit). */
const allowedKinds = (req) => KIND_NAMES.filter((k) => req.tenant.hasPermission(KINDS[k].permission));

/** GET /trash: what is in the trash, newest first (up to 200 per kind). */
async function list(workspaceId, kinds) {
  const items = [];
  for (const kind of kinds) {
    const attributes = kind === 'page'
      ? ['id', 'websiteId', 'title', 'path', 'publishedData', 'deletedAt', 'deletedBy']
      : ['id', 'name', 'subdomain', 'status', 'deletedAt', 'deletedBy'];
    const rows = await KINDS[kind].model().findAll({
      where: { workspaceId, deletedAt: { [Op.ne]: null } },
      attributes,
      paranoid: false,
      order: [['deletedAt', 'DESC']],
      limit: 200,
    });
    items.push(...rows.map((row) => ({ kind, row })));
  }
  const userIds = [...new Set(items.map((i) => i.row.deletedBy).filter(Boolean))];
  const websiteIds = [...new Set(items.filter((i) => i.kind === 'page').map((i) => i.row.websiteId))];
  const [users, websites] = await Promise.all([
    userIds.length ? db.User.findAll({ where: { id: userIds }, attributes: ['id', 'fullName'] }) : [],
    websiteIds.length ? db.Website.findAll({ where: { id: websiteIds, workspaceId }, attributes: ['id', 'name', 'deletedAt'], paranoid: false }) : [],
  ]);
  const userMap = new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName }]));
  const siteMap = new Map(websites.map((w) => [w.id, w]));
  return {
    retentionDays: RETENTION_DAYS,
    items: items
      .map(({ kind, row }) => present(kind, row, userMap, siteMap))
      .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)),
  };
}

/** POST /trash/:kind/:id/restore */
async function restore(workspaceId, kind, id, req) {
  const spec = KINDS[kind];
  return db.sequelize.transaction(async (t) => {
    const row = await loadTrashed(workspaceId, kind, id, t);
    if (kind === 'page') {
      const site = await db.Website.findOne({ where: { id: row.websiteId, workspaceId }, attributes: ['id'], transaction: t });
      if (!site) throw new ConflictError("This page's website is in the trash: restore the website first", 'WEBSITE_IN_TRASH');
    }
    const deletedAt = row.deletedAt;
    await row.restore({ transaction: t });
    await spec.model().update({ deletedBy: null }, { where: { id: row.id }, hooks: false, transaction: t });
    row.deletedBy = null;
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: `${spec.action}.restore`,
      entityType: spec.entityType,
      entityId: row.id,
      after: { deletedAt: null },
      metadata: { trashedAt: deletedAt },
      req,
      transaction: t,
    });
    return { restored: true, kind, id: row.id, item: kind === 'page' ? { id: row.id, websiteId: row.websiteId, path: row.path, title: row.title } : row.toJSON() };
  });
}

/** What the purge audit keeps of the row (never a page's whole tree). */
function summary(kind, row) {
  if (kind === 'page') return { id: row.id, websiteId: row.websiteId, path: row.path, title: row.title, deletedAt: row.deletedAt };
  return { id: row.id, name: row.name, subdomain: row.subdomain, status: row.status, deletedAt: row.deletedAt };
}

/**
 * DELETE /trash/:kind/:id (req set) and the sweep (req null): deletes it for
 * good. The database cascades take what hangs off it, as the old delete did.
 */
async function purge(workspaceId, kind, id, req) {
  const spec = KINDS[kind];
  return db.sequelize.transaction(async (t) => {
    const row = await loadTrashed(workspaceId, kind, id, t);
    const before = summary(kind, row);
    const metadata = { automatic: !req, retentionDays: RETENTION_DAYS };

    if (kind === 'funnel') {
      // orders.funnel_id is SET NULL by the purge: the order keeps the name.
      const [, n] = await db.sequelize.query(
        'UPDATE orders SET funnel_name = :name WHERE funnel_id = :id AND workspace_id = :workspaceId AND funnel_name IS NULL',
        { replacements: { name: row.name, id: row.id, workspaceId }, transaction: t }
      );
      metadata.ordersKeptName = typeof n === 'number' ? n : (n && n.rowCount) || 0;
    }

    if (kind === 'website') {
      // domains.website_id cascades: the store's domains move to another of its websites instead.
      const domains = await db.Domain.count({ where: { websiteId: row.id, workspaceId }, transaction: t });
      if (domains > 0) {
        const other =
          (await db.Website.findOne({ where: { workspaceId, id: { [Op.ne]: row.id } }, order: [['createdAt', 'ASC']], attributes: ['id'], transaction: t })) ||
          (await db.Website.findOne({ where: { workspaceId, id: { [Op.ne]: row.id } }, order: [['createdAt', 'ASC']], attributes: ['id'], paranoid: false, transaction: t }));
        if (!other) {
          throw new ConflictError("This is the store's only website and its domains point at it: remove the domains first, or restore it", 'WEBSITE_HAS_DOMAINS');
        }
        await db.Domain.update({ websiteId: other.id }, { where: { websiteId: row.id, workspaceId }, transaction: t });
        metadata.domainsMovedTo = other.id;
      }
    }

    await row.destroy({ force: true, transaction: t });
    await recordAudit({
      workspaceId,
      actorUserId: req && req.user ? req.user.id : null,
      action: `${spec.action}.purge`,
      entityType: spec.entityType,
      entityId: id,
      before,
      metadata,
      req: req || undefined,
      transaction: t,
    });
    return { purged: true, kind, id };
  });
}

/** Schedule: purges what has been in the trash longer than RETENTION_DAYS, oldest first. */
async function sweep({ now = new Date(), limit = 200 } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  let purged = 0;
  // Pages and funnels before websites, so a page is never purged by its website's cascade mid-loop.
  for (const kind of ['page', 'funnel', 'website']) {
    const rows = await KINDS[kind].model().findAll({
      where: { deletedAt: { [Op.lt]: cutoff } },
      attributes: ['id', 'workspaceId'],
      paranoid: false,
      order: [['deletedAt', 'ASC']],
      limit,
    });
    for (const row of rows) {
      try {
        await purge(row.workspaceId, kind, row.id, null);
        purged += 1;
      } catch (err) {
        logger.warn(`trash sweep: ${kind} ${row.id} kept: ${err.message}`);
      }
    }
  }
  if (purged > 0) logger.info(`trash sweep: purged ${purged} item(s) older than ${RETENTION_DAYS} days`);
  return { purged };
}

module.exports = { RETENTION_DAYS, KINDS, KIND_NAMES, allowedKinds, moveToTrash, list, restore, purge, sweep, purgeAt };
