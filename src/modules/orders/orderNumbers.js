'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Short sequential order numbers (spec-gaps item 381), the way Lightfunnels
 * and Shopify number orders: #1001, #1002, …
 *
 *   settings.order_number = { prefix, suffix, start }
 *     prefix, suffix  0–10 of A–Z 0–9 # - (stored upper-case, so a shopper
 *                     typing the number in any case still finds it)
 *     start           1–10^9: the lowest number the next order may take
 *
 * A store that never set it numbers from #1001 (DEFAULTS). The number is
 * prefix + n + suffix, n from the store's row in order_number_counters,
 * taken by createOrder right before Order.create, inside the order's own
 * transaction: the row stays locked until the order commits or rolls back,
 * so two orders of one store never share a number and a refused order gives
 * its number back. n never goes back: a start lower than the next number
 * changes nothing (GET shows the real next one). A number some order of the
 * store already holds (a prefix changed back and forth) is skipped.
 *
 * (workspace_id, order_number) is unique, and every lookup by number is
 * scoped by store. Orders placed before this keep their ORD-… numbers and are
 * found by them as before.
 */

const DEFAULTS = Object.freeze({ prefix: '#', suffix: '', start: 1001 });
const MAX_START = 1000000000;
// Numbers some order already holds, skipped in a row before giving up.
const MAX_SKIPS = 1000;

const part = Joi.string().trim().max(10).pattern(/^[A-Za-z0-9#-]*$/, 'letters, digits, # and -').allow('').uppercase();
const settingsSchema = Joi.object({
  prefix: part.required(),
  suffix: part.required(),
  start: Joi.number().integer().min(1).max(MAX_START).required(),
});

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.order_number) || null;
  if (!s) return { ...DEFAULTS, isDefault: true };
  return {
    prefix: typeof s.prefix === 'string' ? s.prefix : DEFAULTS.prefix,
    suffix: typeof s.suffix === 'string' ? s.suffix : DEFAULTS.suffix,
    start: Number.isInteger(s.start) && s.start >= 1 ? s.start : DEFAULTS.start,
    isDefault: false,
  };
}

const format = (s, n) => `${s.prefix}${n}${s.suffix}`;

/**
 * The next order number of the store. Call inside the order's transaction
 * (the counter row stays locked until it ends).
 */
async function next(workspaceId, transaction) {
  if (!transaction) throw new Error('orderNumbers.next needs the order transaction');
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  const s = settingsOf(workspace);
  for (let i = 0; i < MAX_SKIPS; i++) {
    const [row] = await db.sequelize.query(
      `INSERT INTO order_number_counters (workspace_id, last_number, created_at, updated_at)
       VALUES (:workspaceId, :start, now(), now())
       ON CONFLICT (workspace_id) DO UPDATE
         SET last_number = GREATEST(order_number_counters.last_number + 1, :start), updated_at = now()
       RETURNING last_number`,
      { replacements: { workspaceId, start: s.start }, type: QueryTypes.SELECT, transaction }
    );
    const candidate = format(s, row.last_number);
    const [taken] = await db.sequelize.query('SELECT 1 FROM orders WHERE workspace_id = :workspaceId AND order_number = :candidate LIMIT 1', {
      replacements: { workspaceId, candidate },
      type: QueryTypes.SELECT,
      transaction,
    });
    if (!taken) return candidate;
  }
  throw new AppError('ORDER_NUMBER_UNAVAILABLE', 'No free order number; change the order number prefix or start', 409);
}

/**
 * What a person may type for an order number: as printed, in any case, with
 * or without the leading # ("1001", "#1001", "ord-lx2…" all find theirs).
 */
function candidates(input) {
  const raw = String(input == null ? '' : input).trim().toUpperCase();
  if (!raw) return [];
  const bare = raw.replace(/^#+/, '');
  return [...new Set([raw, bare, bare && `#${bare}`].filter(Boolean))];
}

/** A `where` value for Order.orderNumber matching what was typed. */
function matching(input) {
  return { [db.Sequelize.Op.in]: candidates(input).length ? candidates(input) : [''] };
}

/** The store's order by a typed number, the exact spelling first. Null when none. */
async function findByNumber(workspaceId, input, options = {}) {
  const list = candidates(input);
  if (!list.length) return null;
  const rows = await db.Order.findAll({ ...options, where: { ...(options.where || {}), workspaceId, orderNumber: list } });
  return rows.sort((a, b) => list.indexOf(a.orderNumber) - list.indexOf(b.orderNumber))[0] || null;
}

/** The order number as a courier reference: letters, digits and - only. */
function carrierReference(order) {
  return String(order.orderNumber || '').replace(/[^A-Za-z0-9-]/g, '') || String(order.id).slice(0, 8).toUpperCase();
}

async function view(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const s = settingsOf(workspace);
  const [row] = await db.sequelize.query('SELECT last_number FROM order_number_counters WHERE workspace_id = :workspaceId', {
    replacements: { workspaceId },
    type: QueryTypes.SELECT,
  });
  const last = row ? Number(row.last_number) : 0;
  const n = Math.max(last + 1, s.start);
  return { prefix: s.prefix, suffix: s.suffix, start: s.start, isDefault: s.isDefault, lastNumber: last || null, nextNumber: n, nextOrderNumber: format(s, n) };
}

// Mounted at /api/v1/workspaces/:workspaceId/order-numbers.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });

router.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params }), asyncHandler(async (req, res) => {
  res.json(await view(req.tenant.workspaceId));
}));

router.put('/', requirePermission(PERMISSIONS.WORKSPACE_MANAGE), validate({ params, body: settingsSchema }), asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const { prefix, suffix, start } = req.body;
  await db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = settingsOf(workspace);
    const after = { prefix, suffix, start };
    await workspace.update({ settings: { ...(workspace.settings || {}), order_number: after } }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order_number.update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before: { prefix: before.prefix, suffix: before.suffix, start: before.start },
      after,
      req,
      transaction,
    });
  });
  res.json(await view(workspaceId));
}));

module.exports = { router, next, candidates, matching, findByNumber, carrierReference, settingsOf, settingsSchema, DEFAULTS };
