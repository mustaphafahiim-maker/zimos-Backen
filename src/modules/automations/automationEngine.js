'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

const TRIGGERS = [
  'order.created',
  'order.confirmed',
  'order.rejected',
  'order.cancelled',
  'order.shipped',
  'order.out_for_delivery',
  'order.delivered',
];

const TOKENS = ['customer_name', 'order_number', 'order_total', 'store_name', 'tracking_url', 'city'];

function formatTotal(amountMinor, currency) {
  const major = Number(amountMinor || 0) / 100;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: major % 1 ? 2 : 0, maximumFractionDigits: 2 })} ${currency}`;
}

/** Replaces {{token}} placeholders with real order data. Unknown tokens become empty. */
function render(value, ctx) {
  return String(value).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, token) => (ctx[token] !== undefined && ctx[token] !== null ? String(ctx[token]) : ''));
}

function conditionsPass(conditions, order) {
  const c = conditions && !Array.isArray(conditions) ? conditions : {};
  if (c.paymentMethod && order.paymentMethod !== c.paymentMethod) return `payment method is ${order.paymentMethod}`;
  if (c.minTotalAmount !== undefined && c.minTotalAmount !== null && Number(order.totalAmount) < Number(c.minTotalAmount)) return 'order total below the minimum';
  return null;
}

async function run(workspaceId, trigger, orderId) {
  const rules = await db.AutomationRule.findAll({ where: { workspaceId, trigger, isActive: true } });
  if (rules.length === 0) return [];

  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.Shipment, as: 'shipments', required: false }],
  });
  if (!order) return [];
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name'] });
  const contact = order.contactSnapshot || {};
  const shipments = (order.shipments || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const ctx = {
    customer_name: contact.fullName || '',
    order_number: order.orderNumber,
    order_total: formatTotal(order.totalAmount, order.currency),
    store_name: workspace ? workspace.name : '',
    tracking_url: shipments[0] && shipments[0].trackingUrl ? shipments[0].trackingUrl : '',
    city: (order.shippingAddressSnapshot || {}).city || '',
  };

  // Lazy require: whatsappService → orders modules would otherwise be circular.
  const whatsapp = require('../whatsapp/whatsappService');
  const results = [];
  for (const rule of rules) {
    const skip = conditionsPass(rule.conditions, order);
    if (skip) {
      results.push(await db.AutomationRun.create({ workspaceId, ruleId: rule.id, trigger, orderId, status: 'skipped', detail: skip }));
      continue;
    }
    for (const action of rule.actions || []) {
      if (action.type !== 'whatsapp_template') continue;
      try {
        if (!contact.phone) throw new Error('order has no phone number');
        await whatsapp.sendMessage(workspaceId, {
          to: contact.phone,
          template: { name: action.template, language: action.language || 'ar', params: (action.params || []).map((p) => render(p, ctx)) },
        });
        results.push(await db.AutomationRun.create({ workspaceId, ruleId: rule.id, trigger, orderId, status: 'sent', detail: `whatsapp_template ${action.template}` }));
      } catch (err) {
        results.push(await db.AutomationRun.create({ workspaceId, ruleId: rule.id, trigger, orderId, status: 'failed', detail: String(err.message).slice(0, 500) }));
      }
    }
  }
  return results;
}

/**
 * Fire-and-forget: automations never block or fail the business action that
 * triggered them. Call from `transaction.afterCommit` so the order exists.
 */
function emit(workspaceId, trigger, orderId) {
  run(workspaceId, trigger, orderId).catch((err) => logger.error(`[automations] ${trigger} for order ${orderId} failed: ${err.message}`));
}

module.exports = { TRIGGERS, TOKENS, emit, run, render };
