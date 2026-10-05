'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');

/**
 * What the orders list and the order page show beside the order itself
 * (SPEC §4.3 columns, §4.4 card 1):
 *
 *   items[].imageUrl  the line's picture: its variant's image, else the
 *                     product's first one — read now, so a changed photo
 *                     shows; null when the product has none or is gone
 *   funnelName        the funnel the order came through (source "funnel")
 *   isNewCustomer     the list only: no earlier order from this customer
 *                     in the store
 *
 * One query per kind for a whole page, never one per order.
 */

function firstMediaUrl(media) {
  const first = Array.isArray(media) ? media.find((m) => m && typeof m.url === 'string' && m.url) : null;
  return first ? first.url : null;
}

/** variantId / productId → picture, for every line of these orders. */
async function lineImages(workspaceId, items) {
  const variantIds = [...new Set(items.map((i) => i.variantId).filter(Boolean))];
  const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
  const [variants, products] = await Promise.all([
    variantIds.length
      ? db.ProductVariant.findAll({ where: { id: variantIds }, attributes: ['id', 'productId', 'imageUrl'] })
      : [],
    productIds.length ? db.Product.findAll({ where: { id: productIds, workspaceId }, attributes: ['id', 'media'] }) : [],
  ]);
  const productImage = new Map(products.map((p) => [p.id, firstMediaUrl(p.media)]));
  const variantImage = new Map(variants.map((v) => [v.id, v.imageUrl || productImage.get(v.productId) || null]));
  return (item) => (item.variantId && variantImage.get(item.variantId)) || (item.productId && productImage.get(item.productId)) || null;
}

async function funnelNames(workspaceId, orders) {
  const ids = [...new Set(orders.map((o) => o.funnelId).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.Funnel.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'name'], paranoid: false });
  return new Map(rows.map((f) => [f.id, f.name]));
}

/** The orders whose customer had ordered from this store before them. */
async function returningOrders(workspaceId, orders) {
  const withCustomer = orders.filter((o) => o.customerId);
  if (withCustomer.length === 0) return new Set();
  const rows = await db.sequelize.query(
    `SELECT o.id
       FROM orders o
      WHERE o.id IN (:ids)
        AND EXISTS (SELECT 1 FROM orders p
                     WHERE p.workspace_id = o.workspace_id AND p.customer_id = o.customer_id
                       AND p.id <> o.id AND p.is_test = false
                       AND (p.created_at, p.id) < (o.created_at, o.id))`,
    { replacements: { ids: withCustomer.map((o) => o.id) }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.id));
}

/** Decorates the list's plain order objects (orderService.hydrateOrders) in place. */
async function decorateList(workspaceId, orders) {
  if (orders.length === 0) return orders;
  const [imageOf, funnels, returning] = await Promise.all([
    lineImages(workspaceId, orders.flatMap((o) => o.items || [])),
    funnelNames(workspaceId, orders),
    returningOrders(workspaceId, orders),
  ]);
  for (const order of orders) {
    for (const item of order.items || []) item.imageUrl = imageOf(item);
    order.funnelName = order.funnelId ? funnels.get(order.funnelId) || null : null;
    order.isNewCustomer = Boolean(order.customerId) && !returning.has(order.id);
  }
  return orders;
}

/** The order page's order (orderService.getOrder): pictures and the funnel's name. */
async function decorateOne(workspaceId, order) {
  const [imageOf, funnels] = await Promise.all([lineImages(workspaceId, order.items || []), funnelNames(workspaceId, [order])]);
  for (const item of order.items || []) item.imageUrl = imageOf(item);
  order.funnelName = order.funnelId ? funnels.get(order.funnelId) || null : null;
  return order;
}

module.exports = { decorateList, decorateOne };
