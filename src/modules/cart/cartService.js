'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { toPublicVariant } = require('../storefront/storefrontService');
const { resolveCustomizations, sameCustomizations, snapshotToInput, bindUploadsToCart } = require('../catalog/customFields');

function generateGuestToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Resolves the cart for a guest token, creating one if the token is missing
 * or doesn't match an active cart in THIS workspace. A guest token from
 * another workspace never resolves here — carts are workspace-scoped like
 * everything else, so a token can't be replayed across tenants.
 */
async function getOrCreateCart(workspaceId, guestToken) {
  if (guestToken) {
    const existing = await db.Cart.findOne({ where: { workspaceId, guestToken, status: 'active' } });
    if (existing) return existing;
  }
  const token = generateGuestToken();
  return db.Cart.create({ workspaceId, guestToken: token, status: 'active' });
}

async function getCart(workspaceId, cartId) {
  const cart = await db.Cart.findOne({
    where: { id: cartId, workspaceId },
    include: [{ model: db.CartItem, as: 'items', include: [{ model: db.ProductVariant, as: 'variant' }, { model: db.Offer, as: 'offer' }] }],
  });
  if (!cart) throw new NotFoundError('Cart');
  return withComputedTotals(cart);
}

/**
 * Cart totals shown to the shopper are computed fresh from live catalog
 * prices on every read — never trusted from unitPriceSnapshot, which exists
 * only so the UI can show "price changed since you added this" banners.
 * The authoritative price is always resolved again at checkout time inside
 * orderService, exactly like every other entry point into order creation.
 */
function withComputedTotals(cart) {
  const items = (cart.items || []).map((item) => {
    const currentUnitPrice = item.offer ? item.offer.priceAmount : item.variant.priceAmount;
    return {
      id: item.id,
      variantId: item.variantId,
      offerId: item.offerId,
      quantity: item.quantity,
      unitPriceSnapshot: item.unitPriceSnapshot,
      currentUnitPrice,
      priceChanged: Number(currentUnitPrice) !== Number(item.unitPriceSnapshot),
      lineTotal: Number(currentUnitPrice) * item.quantity,
      variant: item.variant ? toPublicVariant(item.variant) : null,
      isOrderBump: item.isOrderBump,
      // The shopper's answers, labels included; photos by upload id only.
      customizations: item.customizations || null,
    };
  });
  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  return {
    id: cart.id,
    guestToken: cart.guestToken,
    currency: cart.currency,
    status: cart.status,
    items,
    subtotal,
  };
}

async function addItem(workspaceId, cartId, { variantId, offerId, quantity, customizations, visitorId }) {
  // A draft or archived product isn't for sale, even if its variant row is active.
  const variant = await db.ProductVariant.findOne({
    where: { id: variantId, workspaceId, status: 'active' },
    include: [{ model: db.Product, as: 'product', where: { status: 'active' }, attributes: ['id', 'customFields'] }],
  });
  if (!variant) throw new NotFoundError('ProductVariant');

  // Checked against the product's fields as the shopper adds it; checked again
  // at checkout. A photo must be this visitor's, or already in this cart.
  const snapshot = await resolveCustomizations(variant.product, customizations, {
    workspaceId,
    visitorId,
    cartId,
    enforceRequired: true,
  });

  let unitPrice = variant.priceAmount;
  if (offerId) {
    const offer = await db.Offer.findOne({ where: { id: offerId, workspaceId, productId: variant.productId, status: 'active' } });
    if (!offer) throw new NotFoundError('Offer');
    unitPrice = offer.priceAmount;
  }

  // The same product with different answers ("Ahmed" / "Sara" engraved) is a
  // line of its own; only identical ones add up.
  const candidates = await db.CartItem.findAll({ where: { cartId, variantId, offerId: offerId || null } });
  const existing = candidates.find((line) => sameCustomizations(line.customizations, snapshot));
  if (existing) {
    await existing.update({ quantity: existing.quantity + quantity, unitPriceSnapshot: unitPrice });
  } else {
    await db.CartItem.create({
      cartId,
      variantId,
      offerId: offerId || null,
      quantity,
      unitPriceSnapshot: unitPrice,
      customizations: snapshot,
    });
  }
  await bindUploadsToCart(snapshot, cartId);

  return getCart(workspaceId, cartId);
}

async function updateItemQuantity(workspaceId, cartId, itemId, quantity) {
  const item = await db.CartItem.findOne({ where: { id: itemId, cartId } });
  if (!item) throw new NotFoundError('CartItem');
  if (quantity <= 0) {
    await item.destroy();
  } else {
    await item.update({ quantity });
  }
  return getCart(workspaceId, cartId);
}

async function removeItem(workspaceId, cartId, itemId) {
  const item = await db.CartItem.findOne({ where: { id: itemId, cartId } });
  if (!item) throw new NotFoundError('CartItem');
  await item.destroy();
  return getCart(workspaceId, cartId);
}

/** Used by the checkout endpoint to turn cart rows into orderService's item shape. */
async function toOrderItems(workspaceId, cartId) {
  const cart = await db.Cart.findOne({ where: { id: cartId, workspaceId, status: 'active' }, include: [{ model: db.CartItem, as: 'items' }] });
  if (!cart) throw new NotFoundError('Cart');
  if (!cart.items || cart.items.length === 0) {
    throw new AppError('EMPTY_CART', 'Cart has no items', 422);
  }
  return {
    cart,
    items: cart.items.map((i) => ({
      variantId: i.variantId,
      offerId: i.offerId || undefined,
      quantity: i.quantity,
      // Re-checked against the product when the order is made.
      customizations: snapshotToInput(i.customizations),
    })),
  };
}

async function markConverted(cartId, orderId) {
  await db.Cart.update({ status: 'converted' }, { where: { id: cartId } });
}

module.exports = { getOrCreateCart, getCart, addItem, updateItemQuantity, removeItem, toOrderItems, markConverted };
