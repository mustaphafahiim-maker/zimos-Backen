'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { toDisplay } = require('../../core/utils/money');
const service = require('./merchantNotificationService');

/**
 * Where business events become merchant notifications. Other modules call one
 * function here from `transaction.afterCommit` (the same fire-and-forget
 * pattern as automationEngine.emit) and know nothing about recipients,
 * preferences or channels.
 */

const today = () => new Date().toISOString().slice(0, 10);

const variantLabel = (variant) => {
  const options = Object.values(variant.optionValues || {}).join(' / ');
  const name = variant.product ? variant.product.name : '';
  return [name, options].filter(Boolean).join(' — ') || variant.sku || variant.id;
};

/** A new order: tell the team, flag it if the fraud rules did, and warn about stock it used up. */
async function orderCreated(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.OrderItem, as: 'items', attributes: ['variantId'], required: false }],
  });
  if (!order) return;
  const customerName = (order.contactSnapshot || {}).fullName || '';
  const total = `${toDisplay(order.totalAmount)} ${order.currency}`;
  const data = { orderId: order.id, orderNumber: order.orderNumber, customerName, total };
  const link = `/orders/${order.id}`;

  await service.create(workspaceId, {
    type: 'order.new',
    title: `طلب جديد ${order.orderNumber}`,
    body: [customerName, total].filter(Boolean).join(' — '),
    link,
    data,
    dedupeKey: `order.new:${order.id}`,
  });

  if ((order.riskFlags || []).length > 0) {
    await service.create(workspaceId, {
      type: 'order.suspicious',
      title: `طلب مشتبه به ${order.orderNumber}`,
      body: 'قواعد الحماية علّمت هذا الطلب للمراجعة قبل تأكيده.',
      link,
      data: { ...data, riskFlags: order.riskFlags },
      dedupeKey: `order.suspicious:${order.id}`,
    });
  }

  const variantIds = [...new Set((order.items || []).map((i) => i.variantId).filter(Boolean))];
  if (variantIds.length === 0) return;
  const variants = await db.ProductVariant.findAll({
    where: { workspaceId, id: variantIds, status: 'active' },
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }],
  });
  for (const variant of variants) {
    if (variant.lowStockThreshold === null || variant.lowStockThreshold === undefined) continue;
    const available = variant.stockOnHand - variant.reservedStock;
    if (available > variant.lowStockThreshold) continue;
    const label = variantLabel(variant);
    await service.create(workspaceId, {
      type: 'stock.low',
      title: `المخزون قارب على النفاد: ${label}`,
      body: `المتاح ${available} قطعة.`,
      link: `/catalog/${variant.productId}`,
      data: { productId: variant.productId, variantId: variant.id, label, available },
      // One reminder a day per variant, however many orders it appears in.
      dedupeKey: `stock.low:${variant.id}:${today()}`,
    });
  }
}

/** A connected service (gateway, courier, WhatsApp) stopped working. Once a day per integration. */
function integrationFailed(workspaceId, { integration, message, link = '/settings' }) {
  return service.create(workspaceId, {
    type: 'integration.failed',
    title: `تعذّر الاتصال بـ ${integration}`,
    body: message ? String(message).slice(0, 500) : null,
    link,
    data: { integration, message: message ? String(message).slice(0, 500) : null },
    dedupeKey: `integration.failed:${integration}:${today()}`,
  });
}

/** A file one teammate asked for is ready. */
function exportReady(workspaceId, userId, { name, link }) {
  return service.create(workspaceId, {
    type: 'export.ready',
    title: `الملف جاهز: ${name}`,
    link,
    data: { name },
    userIds: [userId],
  });
}

const money = (minor, currency) => `${toDisplay(minor)} ${currency}`;

/** The prepaid balance is low or below zero (billing/walletService, a plan with a debt limit). Once a day. */
function walletLow(workspaceId, wallet) {
  return service.create(workspaceId, {
    type: 'wallet.low',
    title: wallet.balance <= 0 ? 'رصيد Zimos أصبح صفرًا أو أقل' : 'رصيد Zimos يقترب من النفاد',
    body: `الرصيد ${money(wallet.balance, wallet.currency)}. اشحنه حتى لا تتوقف الطلبات الجديدة.`,
    link: '/subscription?tab=usage',
    data: { balance: wallet.balance, fee: wallet.fee, ordersLeft: wallet.ordersLeft, currency: wallet.currency },
    dedupeKey: `wallet.low:${today()}`,
  });
}

/** The balance reached the plan's debt limit: new orders are refused until a top-up. Once a day. */
function walletLimitReached(workspaceId, wallet) {
  return service.create(workspaceId, {
    type: 'wallet.limit_reached',
    title: 'وصل رصيد Zimos إلى الحد: الطلبات الجديدة متوقفة',
    body: `المديونية ${money(wallet.debt, wallet.currency)}. اشحن رصيدك لتعود الطلبات الجديدة.`,
    link: '/subscription?tab=usage',
    data: { balance: wallet.balance, debt: wallet.debt, limit: wallet.overdraft, currency: wallet.currency },
    dedupeKey: `wallet.limit_reached:${today()}`,
  });
}

const HANDLERS = { 'order.created': orderCreated };

/** Fire-and-forget, like automationEngine.emit; awaited under test for the same reason. */
function emit(workspaceId, event, entityId) {
  const handler = HANDLERS[event];
  if (!handler) return undefined;
  const work = handler(workspaceId, entityId).catch((err) =>
    logger.error(`[merchant-notifications] ${event} for ${entityId} failed: ${err.message}`)
  );
  return env.isTest ? work : undefined;
}

module.exports = { emit, orderCreated, integrationFailed, exportReady, walletLow, walletLimitReached };
