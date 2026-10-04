'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { applyBasisPoints } = require('../../core/utils/money');
const { recordAudit } = require('../audit/auditService');

/**
 * Payment rules (SPEC §11.4).
 *
 * 1. **Fee or discount per payment method** — `settings.payment_adjustments`:
 *    [{ method, type: 'fee'|'discount', valueType: 'fixed'|'percent', value, label }]
 *    `value` is minor units for `fixed` and basis points for `percent`. The
 *    percentage is taken from the goods after the discount code plus shipping
 *    (tax is left out). One rule per method; the result is its own line of the
 *    order (orders.payment_adjustment_amount, signed) and part of the total.
 *
 * 2. **Methods per funnel** — `settings.payment_methods_by_funnel`:
 *    { [funnelId]: [method id, …] } — the payment method ids (as the
 *    storefront lists them: 'cod', 'paymob:card', 'manual:<id>') a funnel's
 *    checkout offers. A funnel with no entry offers everything the store does.
 */

const METHODS = [...require('./methodNames').ORDER_METHODS];
const MAX_FUNNEL_RULES = 200;

function adjustments(settings) {
  const list = settings && settings.payment_adjustments;
  return Array.isArray(list) ? list : [];
}

function funnelMap(settings) {
  const map = settings && settings.payment_methods_by_funnel;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/**
 * The adjustment for one order. `base` = subtotal − discount + shipping.
 * A discount never takes the order below zero.
 * @returns {{ amount: number, label: string|null }}
 */
function adjustmentFor(settings, paymentMethod, base) {
  const rule = adjustments(settings).find((r) => r.method === paymentMethod && r.enabled !== false);
  if (!rule || !Number.isInteger(Number(rule.value)) || Number(rule.value) <= 0) return { amount: 0, label: null };
  const raw = rule.valueType === 'percent' ? applyBasisPoints(Math.max(0, base), Number(rule.value)) : Number(rule.value);
  const amount = rule.type === 'discount' ? -Math.min(raw, Math.max(0, base)) : raw;
  return { amount, label: rule.label || null };
}

/** Same, loading the store's settings (inside the caller's transaction, if any). */
async function adjustmentForWorkspace(workspaceId, paymentMethod, base, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  return adjustmentFor(workspace ? workspace.settings : null, paymentMethod, base);
}

/**
 * The shopper changed how they pay (online → cash on delivery): the old
 * method's adjustment comes off the total and the new method's goes on.
 * Returns the fields to write on the order.
 */
async function repriceForMethod(order, paymentMethod, transaction) {
  const goods = Number(order.subtotalAmount) - Number(order.discountAmount) + Number(order.shippingAmount);
  const next = await adjustmentForWorkspace(order.workspaceId, paymentMethod, goods, transaction);
  const withoutOld = Number(order.totalAmount) - Number(order.paymentAdjustmentAmount || 0);
  const totalAmount = withoutOld + next.amount;
  const base = await require('../currencies/fxService').baseFieldsFor(order.workspaceId, { currency: order.currency, totalAmount }, transaction);
  return {
    paymentAdjustmentAmount: next.amount,
    paymentAdjustmentLabel: next.label,
    totalAmount,
    ...base,
  };
}

/** What the storefront shows next to a method: the rule itself, never a computed price. */
function describeFor(settings, method) {
  const rule = adjustments(settings).find((r) => r.method === method && r.enabled !== false);
  if (!rule || Number(rule.value) <= 0) return null;
  return { type: rule.type, valueType: rule.valueType, value: Number(rule.value), label: rule.label || null };
}

/** Narrows the store's methods to a funnel's, and attaches each method's adjustment. */
function forStorefront(workspace, methods, funnelId) {
  const settings = workspace.settings || {};
  const allowed = funnelId ? funnelMap(settings)[funnelId] : null;
  const narrowed = Array.isArray(allowed) && allowed.length ? methods.filter((m) => allowed.includes(m.id)) : methods;
  // A funnel list that no longer matches anything the store offers must not leave the checkout with no way to pay.
  const list = narrowed.length ? narrowed : methods;
  return list.map((m) => {
    const adjustment = describeFor(settings, m.method);
    return adjustment ? { ...m, adjustment } : m;
  });
}

/** 422 when a funnel checkout uses a method the funnel does not offer. */
function assertAllowedInFunnel(workspace, { funnelId, methodId }) {
  if (!funnelId) return;
  const allowed = funnelMap(workspace.settings)[funnelId];
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  if (!allowed.includes(methodId)) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not offered in this funnel', 422);
  }
}

// ---------------------------------------------------------------- settings --

function getSettings(workspace) {
  return {
    adjustments: adjustments(workspace.settings),
    methodsByFunnel: funnelMap(workspace.settings),
    methods: METHODS,
  };
}

async function saveSettings(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = getSettings(workspace);
    const settings = { ...(workspace.settings || {}) };
    if (body.adjustments) {
      settings.payment_adjustments = body.adjustments.map((r) => ({
        method: r.method,
        type: r.type,
        valueType: r.valueType,
        value: r.value,
        label: r.label ? r.label.trim() : null,
        enabled: r.enabled !== false,
      }));
    }
    if (body.methodsByFunnel) {
      const funnels = await db.Funnel.findAll({ where: { workspaceId }, attributes: ['id'], transaction });
      const known = new Set(funnels.map((f) => f.id));
      const next = {};
      for (const [funnelId, ids] of Object.entries(body.methodsByFunnel).slice(0, MAX_FUNNEL_RULES)) {
        if (known.has(funnelId) && Array.isArray(ids) && ids.length) next[funnelId] = [...new Set(ids)];
      }
      settings.payment_methods_by_funnel = next;
    }
    workspace.settings = settings;
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    const after = getSettings(workspace);
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'payment_rules.update', entityType: 'Workspace', entityId: workspaceId,
      before, after, req, transaction,
    });
    return after;
  });
}

module.exports = {
  METHODS,
  adjustmentFor,
  adjustmentForWorkspace,
  repriceForMethod,
  forStorefront,
  assertAllowedInFunnel,
  getSettings,
  saveSettings,
};
