'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { effectiveVariantPrice } = require('../catalog/productPage');

/*
 * Exchanges (item 372): the shopper got size M and wants L. A return with
 * resolution 'exchange' names, on each of its lines, the variant of the same
 * product the shopper wants instead (exchangeVariantId). When the merchant
 * approves it, a replacement order is made for those variants and linked to
 * the return (exchangeOrderId); the returned units come back through the
 * usual restock step.
 *
 * The replacement order charges only what the new variant costs more than
 * the one sent back, at today's prices (nothing when they cost the same or
 * the new one costs less: a difference owed to the shopper is refunded on the
 * original order as usual), plus the shipping the merchant typed when
 * approving (none by default). It is cash on delivery, exact prices (no
 * bundle tier or automatic discount on top), tagged 'exchange'.
 */

const PINNED = Symbol.for('zimos.productTestPrice');
const EXACT_PRICES = Symbol.for('zimos.exactPrices');
const LABEL = Symbol.for('zimos.lineLabel');

const inStock = (v) => Boolean(v.allowOverselling) || v.availableStock() > 0;

/** Per order line, the other variants of its product a shopper may swap to. */
async function exchangeOptions(workspaceId, orderItems) {
  const productIds = [...new Set(orderItems.map((i) => i.productId).filter(Boolean))];
  if (!productIds.length) return new Map();
  // A draft or archived product is not for sale even when its variant row is active (orderService.priceLine).
  const variants = await db.ProductVariant.findAll({
    where: { workspaceId, productId: productIds, status: 'active' },
    include: [{ model: db.Product, as: 'product', attributes: ['id'], where: { status: 'active' } }],
    order: [['createdAt', 'ASC']],
  });
  const out = new Map();
  for (const item of orderItems) {
    out.set(
      item.id,
      variants
        .filter((v) => v.productId === item.productId && v.id !== item.variantId)
        .map((v) => ({ variantId: v.id, options: v.optionValues || {}, inStock: inStock(v) }))
    );
  }
  return out;
}

/**
 * Problems with the lines of a return for its resolution: an exchange needs
 * an exchangeVariantId on every line, of the same product and another
 * variant, still on sale; a refund takes none.
 */
async function lineProblems(workspaceId, resolution, items, orderItemsById, prefix = 'items') {
  const problems = [];
  if (resolution !== 'exchange') {
    items.forEach((line, i) => {
      if (line.exchangeVariantId) problems.push({ field: `${prefix}.${i}.exchangeVariantId`, message: 'Only an exchange names a variant to swap to' });
    });
    return problems;
  }
  const ids = [...new Set(items.map((l) => l.exchangeVariantId).filter(Boolean))];
  const variants = ids.length
    ? await db.ProductVariant.findAll({ where: { id: ids, workspaceId }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'status'], required: false }] })
    : [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  items.forEach((line, i) => {
    const oi = orderItemsById.get(line.orderItemId);
    if (!oi) return; // reported by the caller
    const v = line.exchangeVariantId ? byId.get(line.exchangeVariantId) : null;
    if (!line.exchangeVariantId) problems.push({ field: `${prefix}.${i}.exchangeVariantId`, message: 'Pick the size or colour you want instead' });
    else if (!v || v.productId !== oi.productId) problems.push({ field: `${prefix}.${i}.exchangeVariantId`, message: 'Pick another variant of the same product' });
    else if (v.id === oi.variantId) problems.push({ field: `${prefix}.${i}.exchangeVariantId`, message: 'Pick a different variant from the one you got' });
    else if (v.status !== 'active' || !v.product || v.product.status !== 'active') problems.push({ field: `${prefix}.${i}.exchangeVariantId`, message: 'This variant is no longer sold' });
  });
  return problems;
}

/**
 * Makes the replacement order of an approved exchange, inside the approval's
 * transaction (out of stock or a variant gone fails the approval). Returns
 * the order.
 */
async function createReplacementOrder(workspaceId, ret, { shippingAmount = 0 } = {}, req, transaction) {
  const order = await db.Order.findOne({ where: { id: ret.orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  const orderItems = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
  const byId = new Map(orderItems.map((oi) => [oi.id, oi]));
  const variantIds = [...new Set(ret.items.flatMap((l) => [l.exchangeVariantId, (byId.get(l.orderItemId) || {}).variantId]).filter(Boolean))];
  const variants = await db.ProductVariant.findAll({
    where: { id: variantIds, workspaceId },
    include: [{ model: db.Product, as: 'product', required: false }],
    transaction,
  });
  const vById = new Map(variants.map((v) => [v.id, v]));
  const priceOf = (v) => (v ? Number(effectiveVariantPrice(v, v.product).priceAmount) : 0);

  const items = ret.items.map((line) => {
    const oi = byId.get(line.orderItemId);
    const swapTo = vById.get(line.exchangeVariantId);
    const sentBack = oi && oi.variantId ? vById.get(oi.variantId) : null;
    // The gap between the two variants at today's prices; the original line's own price when its variant is gone.
    const was = sentBack ? priceOf(sentBack) : Number(oi ? oi.unitPriceAmount : 0);
    const difference = Math.max(0, priceOf(swapTo) - was);
    return { variantId: line.exchangeVariantId, quantity: line.quantity, [PINNED]: difference, [LABEL]: `Exchange for ${order.orderNumber}`.slice(0, 120) };
  });

  const contact = order.contactSnapshot || {};
  const { order: created } = await require('../orders/orderService').createOrder(
    workspaceId,
    {
      contact: { fullName: contact.fullName, phone: contact.phone, email: contact.email || undefined },
      shippingAddress: order.shippingAddressSnapshot || undefined,
      paymentMethod: 'cod',
      items,
      notes: `Exchange for return of order ${order.orderNumber}`.slice(0, 1000),
      [EXACT_PRICES]: true,
    },
    req,
    { transaction, shippingOverride: { amount: Number(shippingAmount) || 0 }, locale: order.locale }
  );
  await db.Order.update({ tags: [...new Set([...(created.tags || []), 'exchange'])] }, { where: { id: created.id }, hooks: false, transaction });
  return created;
}

module.exports = { exchangeOptions, lineProblems, createReplacementOrder };
