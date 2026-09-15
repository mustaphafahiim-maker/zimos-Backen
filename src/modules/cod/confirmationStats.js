'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { PERMISSIONS } = require('../../core/security/permissions');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Call log: every confirmation attempt with its order and agent, newest first. */
const listAttempts = asyncHandler(async (req, res) => {
  const { limit, before, agentUserId, outcome } = req.query;
  const where = {};
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  if (agentUserId) where.agentUserId = agentUserId;
  if (outcome) where.outcome = outcome;

  const rows = await db.ConfirmationAttempt.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    include: [
      {
        model: db.ConfirmationTask,
        as: 'task',
        required: true,
        where: { workspaceId: req.tenant.workspaceId },
        attributes: ['id', 'orderId', 'attemptCount', 'status'],
      },
    ],
  });

  const orderIds = [...new Set(rows.map((r) => r.task.orderId))];
  const agentIds = [...new Set(rows.map((r) => r.agentUserId))];
  const [orders, agents] = await Promise.all([
    orderIds.length ? db.Order.findAll({ where: { id: orderIds }, attributes: ['id', 'orderNumber', 'contactSnapshot', 'totalAmount', 'currency'] }) : [],
    agentIds.length ? db.User.findAll({ where: { id: agentIds }, attributes: ['id', 'fullName', 'email'] }) : [],
  ]);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const agentById = new Map(agents.map((u) => [u.id, u]));

  res.json({
    attempts: rows.map((r) => {
      const o = orderById.get(r.task.orderId);
      const a = agentById.get(r.agentUserId);
      return {
        id: r.id,
        outcome: r.outcome,
        notes: r.notes,
        createdAt: r.createdAt,
        taskId: r.task.id,
        attemptNumber: r.task.attemptCount,
        agent: a ? { id: a.id, fullName: a.fullName, email: a.email } : { id: r.agentUserId, fullName: null, email: null },
        order: o
          ? { id: o.id, orderNumber: o.orderNumber, customerName: (o.contactSnapshot || {}).fullName || null, phone: (o.contactSnapshot || {}).phone || null, totalAmount: Number(o.totalAmount), currency: o.currency }
          : null,
      };
    }),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

/**
 * Team members who can confirm orders, with their real activity over the
 * last `days` days (attempt counts by outcome) and any task they hold now.
 */
const listAgents = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const since = new Date(Date.now() - req.query.days * DAY_MS);

  const memberships = await db.Membership.findAll({
    where: { workspaceId, status: 'active' },
    include: [
      { model: db.Role, as: 'role', attributes: ['key', 'name', 'permissions'] },
      { model: db.User, as: 'user', attributes: ['id', 'fullName', 'email'] },
    ],
  });
  const agents = memberships.filter((m) => {
    const perms = (m.role && m.role.permissions) || [];
    return perms.includes('*') || perms.includes(PERMISSIONS.ORDERS_CONFIRM);
  });

  const attempts = await db.ConfirmationAttempt.findAll({
    where: { createdAt: { [Op.gte]: since }, agentUserId: agents.map((m) => m.userId) },
    attributes: ['agentUserId', 'outcome'],
    include: [{ model: db.ConfirmationTask, as: 'task', required: true, where: { workspaceId }, attributes: [] }],
  });
  const locked = await db.ConfirmationTask.findAll({
    where: { workspaceId, status: 'in_progress', lockedByUserId: agents.map((m) => m.userId) },
    attributes: ['lockedByUserId', 'lockedAt'],
  });

  res.json({
    range: { days: req.query.days, since: since.toISOString() },
    agents: agents.map((m) => {
      const mine = attempts.filter((a) => a.agentUserId === m.userId);
      const count = (o) => mine.filter((a) => a.outcome === o).length;
      const held = locked.filter((t) => t.lockedByUserId === m.userId);
      const decided = count('confirmed') + count('rejected');
      return {
        userId: m.userId,
        fullName: m.user ? m.user.fullName : null,
        email: m.user ? m.user.email : null,
        role: m.role ? { key: m.role.key, name: m.role.name } : null,
        attempts: mine.length,
        confirmed: count('confirmed'),
        rejected: count('rejected'),
        unreachable: count('unreachable'),
        postponed: count('postponed'),
        confirmationRate: decided > 0 ? Math.round((count('confirmed') / decided) * 1000) / 10 : null,
        tasksInProgress: held.length,
      };
    }),
  });
});

const schemas = {
  attempts: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso().optional(),
      agentUserId: Joi.string().uuid().optional(),
      outcome: Joi.string().valid('confirmed', 'rejected', 'unreachable', 'postponed').optional(),
    }),
  },
  agents: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({ days: Joi.number().integer().min(1).max(366).default(30) }),
  },
};

module.exports = { listAttempts, listAgents, schemas };
