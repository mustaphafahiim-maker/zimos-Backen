'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op, fn, col } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { TRIGGERS, TOKENS } = require('./automationEngine');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };

const ruleBody = {
  name: Joi.string().min(2).max(200),
  trigger: Joi.string().valid(...TRIGGERS),
  isActive: Joi.boolean(),
  conditions: Joi.object({
    paymentMethod: Joi.string().valid('cod', 'card', 'wallet', 'bank_transfer').allow(null),
    minTotalAmount: Joi.number().integer().min(0).allow(null),
  }).default({}),
  actions: Joi.array()
    .items(
      Joi.object({
        type: Joi.string().valid('whatsapp_template').required(),
        template: Joi.string().pattern(/^[a-z0-9_]{1,512}$/).required(),
        language: Joi.string().pattern(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('ar'),
        params: Joi.array().items(Joi.string().max(1000)).max(20).default([]),
      })
    )
    .min(1)
    .max(5),
};

const view = (r, stats = {}) => ({
  id: r.id,
  name: r.name,
  trigger: r.trigger,
  isActive: r.isActive,
  conditions: r.conditions && !Array.isArray(r.conditions) ? r.conditions : {},
  actions: r.actions || [],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  stats: { sent: stats.sent || 0, skipped: stats.skipped || 0, failed: stats.failed || 0, lastRunAt: stats.lastRunAt || null },
});

const list = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const rules = await db.AutomationRule.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  const runs = rules.length
    ? await db.AutomationRun.findAll({
        where: { workspaceId, ruleId: rules.map((r) => r.id) },
        attributes: ['ruleId', 'status', [fn('COUNT', col('id')), 'count'], [fn('MAX', col('created_at')), 'lastRunAt']],
        group: ['ruleId', 'status'],
        raw: true,
      })
    : [];
  const stats = {};
  for (const r of runs) {
    const s = (stats[r.ruleId] = stats[r.ruleId] || {});
    s[r.status] = Number(r.count);
    if (!s.lastRunAt || new Date(r.lastRunAt) > new Date(s.lastRunAt)) s.lastRunAt = r.lastRunAt;
  }
  res.json({ rules: rules.map((r) => view(r, stats[r.id])), triggers: TRIGGERS, tokens: TOKENS });
});

const create = asyncHandler(async (req, res) => {
  const rule = await db.AutomationRule.create({ ...req.body, workspaceId: req.tenant.workspaceId });
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'automation.create', entityType: 'AutomationRule', entityId: rule.id, after: view(rule), req });
  res.status(201).json({ rule: view(rule) });
});

const update = asyncHandler(async (req, res) => {
  const rule = await db.AutomationRule.findOne({ where: { id: req.params.ruleId, workspaceId: req.tenant.workspaceId } });
  if (!rule) throw new NotFoundError('AutomationRule');
  const before = view(rule);
  await rule.update(req.body);
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'automation.update', entityType: 'AutomationRule', entityId: rule.id, before, after: view(rule), req });
  res.json({ rule: view(rule) });
});

const remove = asyncHandler(async (req, res) => {
  const rule = await db.AutomationRule.findOne({ where: { id: req.params.ruleId, workspaceId: req.tenant.workspaceId } });
  if (!rule) throw new NotFoundError('AutomationRule');
  await rule.destroy();
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'automation.delete', entityType: 'AutomationRule', entityId: rule.id, before: view(rule), req });
  res.json({ deleted: true, id: rule.id });
});

const runs = asyncHandler(async (req, res) => {
  const { ruleId, limit, before, status } = req.query;
  const where = { workspaceId: req.tenant.workspaceId };
  if (ruleId) where.ruleId = ruleId;
  if (status) where.status = status;
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.AutomationRun.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean))];
  const orders = orderIds.length ? await db.Order.findAll({ where: { id: orderIds }, attributes: ['id', 'orderNumber'] }) : [];
  const byId = new Map(orders.map((o) => [o.id, o.orderNumber]));
  res.json({
    runs: rows.map((r) => ({ id: r.id, ruleId: r.ruleId, trigger: r.trigger, status: r.status, detail: r.detail, createdAt: r.createdAt, order: r.orderId ? { id: r.orderId, orderNumber: byId.get(r.orderId) || null } : null })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

// Mounted at /api/v1/workspaces/:workspaceId/automations
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.AUTOMATIONS_MANAGE));
router.get('/', validate({ params: Joi.object(ws) }), list);
router.get(
  '/runs',
  validate({
    params: Joi.object(ws),
    query: Joi.object({ ruleId: uuid, status: Joi.string().valid('sent', 'skipped', 'failed'), limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso() }),
  }),
  runs
);
router.post(
  '/',
  validate({ params: Joi.object(ws), body: Joi.object({ ...ruleBody, name: ruleBody.name.required(), trigger: ruleBody.trigger.required(), actions: ruleBody.actions.required() }) }),
  create
);
router.patch('/:ruleId', validate({ params: Joi.object({ ...ws, ruleId: uuid.required() }), body: Joi.object(ruleBody).min(1) }), update);
router.delete('/:ruleId', validate({ params: Joi.object({ ...ws, ruleId: uuid.required() }) }), remove);

module.exports = router;
