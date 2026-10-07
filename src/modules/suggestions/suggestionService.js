'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Suggestions (migration 219): a store's members send ideas, bugs and
 * improvements (Help → Suggest a feature) and read the status and the
 * console's reply; console admins list, filter, change the status and reply.
 * A new suggestion notifies the console through its audit entry
 * (platformAdmin/platformNotificationService, type 'suggestion').
 */
const CATEGORIES = ['feature', 'bug', 'improvement'];
const STATUSES = ['new', 'under_review', 'planned', 'done'];
const LIMITS = { title: 150, description: 4000, contact: 200, reply: 4000 };

const merchantView = (s) => ({
  id: s.id,
  title: s.title,
  description: s.description,
  category: s.category,
  contact: s.contact,
  status: s.status,
  adminReply: s.adminReply,
  repliedAt: s.repliedAt,
  createdAt: s.createdAt,
});

const adminView = (s) => ({
  ...merchantView(s),
  workspace: s.workspace ? { id: s.workspace.id, name: s.workspace.name, slug: s.workspace.slug } : { id: s.workspaceId },
  user: s.user ? { id: s.user.id, fullName: s.user.fullName, email: s.user.email } : null,
  updatedAt: s.updatedAt,
});

async function create(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const suggestion = await db.Suggestion.create(
      {
        workspaceId,
        userId: req.user.id,
        title: body.title,
        description: body.description,
        category: body.category,
        contact: body.contact || null,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'suggestion.create',
      entityType: 'Suggestion',
      entityId: suggestion.id,
      after: { title: suggestion.title, category: suggestion.category },
      req,
      transaction,
    });
    return merchantView(suggestion);
  });
}

/** The store's own suggestions, newest first. */
async function listForWorkspace(workspaceId, { limit = 50 } = {}) {
  const rows = await db.Suggestion.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']], limit });
  return rows.map(merchantView);
}

/** The console's list: filters by status / category, a search over title and description. */
async function listForAdmin({ status, category, q, limit = 50, offset = 0 } = {}) {
  const where = {};
  if (status) where.status = status;
  if (category) where.category = category;
  if (q) {
    const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where[Op.or] = [{ title: { [Op.iLike]: like } }, { description: { [Op.iLike]: like } }];
  }
  const { rows, count } = await db.Suggestion.findAndCountAll({
    where,
    include: [
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug'] },
      { model: db.User, as: 'user', attributes: ['id', 'fullName', 'email'] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
  const counts = await db.Suggestion.findAll({ attributes: ['status', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']], group: ['status'], raw: true });
  return {
    suggestions: rows.map(adminView),
    total: count,
    counts: Object.fromEntries(STATUSES.map((s) => [s, Number((counts.find((c) => c.status === s) || {}).count || 0)])),
  };
}

/** PATCH from the console: a new status and/or the reply the store reads. */
async function updateByAdmin(id, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const suggestion = await db.Suggestion.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!suggestion) throw new NotFoundError('Suggestion');
    const before = { status: suggestion.status, adminReply: suggestion.adminReply };
    if (body.status !== undefined) suggestion.status = body.status;
    if (body.adminReply !== undefined) {
      suggestion.adminReply = body.adminReply ? body.adminReply : null;
      suggestion.repliedAt = body.adminReply ? new Date() : null;
      suggestion.repliedByUserId = body.adminReply ? req.user.id : null;
    }
    await suggestion.save({ transaction });
    await recordAudit({
      workspaceId: suggestion.workspaceId,
      actorUserId: req.user.id,
      action: 'suggestion.update',
      entityType: 'Suggestion',
      entityId: suggestion.id,
      before,
      after: { status: suggestion.status, adminReply: suggestion.adminReply },
      req,
      transaction,
    });
    const full = await db.Suggestion.findByPk(id, {
      include: [
        { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug'] },
        { model: db.User, as: 'user', attributes: ['id', 'fullName', 'email'] },
      ],
      transaction,
    });
    return adminView(full);
  });
}

module.exports = { CATEGORIES, STATUSES, LIMITS, create, listForWorkspace, listForAdmin, updateByAdmin };
