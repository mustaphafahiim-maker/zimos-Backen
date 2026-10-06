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

/**
 * What a new order is, in a line (SPEC §20.1: "product + total + governorate"),
 * in Arabic and English: the first product (× its quantity) and how many more,
 * the total, and the governorate by its name in that language when the
 * address names a known one (geo/geoRegions.js), else as the shopper typed it.
 */
async function orderSummary(order) {
  const items = (order.items || []).slice().sort((a, b) => Number(b.lineTotalAmount || 0) - Number(a.lineTotalAmount || 0));
  const first = items[0];
  const product = first ? `${first.productNameSnapshot}${first.quantity > 1 ? ` × ${first.quantity}` : ''}` : '';
  const more = Math.max(0, items.length - 1);
  const address = order.shippingAddressSnapshot || {};
  let governorate = { ar: address.province || address.city || '', en: address.province || address.city || '' };
  try {
    const place = await require('../geo/geoRegions').resolve(address);
    if (place.governorate) governorate = { ar: place.governorate.nameAr || governorate.ar, en: place.governorate.nameEn || governorate.en };
  } catch {
    /* the typed name will do */
  }
  return { product, more, governorate };
}

/** A new order: tell the team, flag it if the fraud rules did, and warn about stock it used up. */
async function orderCreated(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.OrderItem, as: 'items', attributes: ['variantId', 'productNameSnapshot', 'quantity', 'lineTotalAmount'], required: false }],
  });
  if (!order) return;
  const customerName = (order.contactSnapshot || {}).fullName || '';
  const total = `${toDisplay(order.totalAmount)} ${order.currency}`;
  const { product, more, governorate } = await orderSummary(order);
  // The values the dashboard renders the bell's line from, in the viewer's language (notificationText.ts).
  const data = { orderId: order.id, orderNumber: order.orderNumber, customerName, total, product, moreProducts: more, governorate };
  const link = `/orders/${order.id}`;
  const line = (lang) =>
    [product && (more ? (lang === 'ar' ? `${product} و${more} غيره` : `${product} +${more} more`) : product), total, governorate[lang]]
      .filter(Boolean)
      .join(' · ');

  await service.create(workspaceId, {
    type: 'order.new',
    title: `طلب جديد ${order.orderNumber}`,
    body: line('ar'),
    link,
    data,
    dedupeKey: `order.new:${order.id}`,
    // Push, email and WhatsApp in each teammate's own language (users.locale).
    localized: {
      ar: { title: `طلب جديد ${order.orderNumber}`, body: line('ar') },
      en: { title: `New order ${order.orderNumber}`, body: line('en') },
    },
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

module.exports = { emit, orderCreated, integrationFailed, exportReady };
