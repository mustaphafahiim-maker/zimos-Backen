'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { isUuid } = require('../../core/utils/workspaceSlug');
const { calculateShippingAmount } = require('../shipping/shippingPricing');

/**
 * Where the order is, in shopper words: placed → confirmed → shipped →
 * out for delivery → delivered (or cancelled / returned).
 */
function stageOf(order, shipments) {
  if (order.cancelledAt || order.confirmationState === 'rejected') return 'cancelled';
  if (order.fulfillmentState === 'returned') return 'returned';
  if (order.fulfillmentState === 'fulfilled' || shipments.some((s) => s.status === 'delivered')) return 'delivered';
  if (shipments.some((s) => s.status === 'out_for_delivery')) return 'out_for_delivery';
  if (shipments.some((s) => ['picked_up', 'in_transit'].includes(s.status))) return 'shipped';
  if (order.confirmationState === 'confirmed') return 'confirmed';
  return 'placed';
}

function shopperView(order) {
  const shipments = order.shipments || [];
  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    stage: stageOf(order, shipments),
    confirmationState: order.confirmationState,
    fulfillmentState: order.fulfillmentState,
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    subtotalAmount: Number(order.subtotalAmount),
    discountAmount: Number(order.discountAmount),
    shippingAmount: Number(order.shippingAmount),
    totalAmount: Number(order.totalAmount),
    // Only what the shopper typed themselves, never other customer data.
    contact: { fullName: contact.fullName || null },
    shippingCity: address.city || null,
    items: (order.items || []).map((i) => ({
      productId: i.productId,
      name: i.productNameSnapshot,
      options: i.variantOptionsSnapshot || null,
      offerName: i.offerNameSnapshot || null,
      quantity: i.quantity,
      unitPriceAmount: Number(i.unitPriceAmount),
      lineTotalAmount: Number(i.lineTotalAmount),
    })),
    shipments: shipments.map((s) => ({
      carrierCode: s.carrierCode,
      status: s.status,
      trackingUrl: s.trackingUrl || null,
      trackingCode: s.trackingCode || null,
      updatedAt: s.updatedAt,
    })),
  };
}

/**
 * Public order lookup. The shopper must know BOTH the order reference and the
 * phone number used on it; any mismatch is a plain 404 so order numbers can't
 * be enumerated.
 */
async function lookupOrder(workspaceId, { orderNumber, orderId, phone }) {
  const wanted = normalizePhone(phone);
  const ref = orderId && isUuid(orderId) ? { id: orderId } : orderNumber ? { orderNumber: String(orderNumber).replace(/^#/, '').trim() } : null;
  if (!wanted || !ref) throw new NotFoundError('Order');

  const order = await db.Order.findOne({
    where: { workspaceId, ...ref },
    include: [
      { model: db.OrderItem, as: 'items' },
      { model: db.Shipment, as: 'shipments', required: false },
      { model: db.Customer, as: 'customer', attributes: ['phoneNormalized'] },
    ],
    order: [[{ model: db.Shipment, as: 'shipments' }, 'createdAt', 'ASC']],
  });
  if (!order) throw new NotFoundError('Order');

  const contact = order.contactSnapshot || {};
  const phones = [contact.phone, contact.alternatePhone].map((p) => normalizePhone(p)).filter(Boolean);
  if (order.customer && order.customer.phoneNormalized) phones.push(order.customer.phoneNormalized);
  if (!phones.includes(wanted)) throw new NotFoundError('Order');

  return shopperView(order);
}

/** Shipping price the checkout would charge for this destination and cart shape. */
async function quoteShipping(workspaceId, { country = 'EG', region, subtotal = 0, quantity = 1, weightGrams = 0 }) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'settings'] });
  const amount = await calculateShippingAmount(workspaceId, {
    country,
    region: region || null,
    subtotal: Number(subtotal) || 0,
    totalQuantity: Number(quantity) || 1,
    totalWeightGrams: Number(weightGrams) || 0,
  });
  const threshold = workspace && workspace.settings ? workspace.settings.free_shipping_threshold_amount : null;
  return {
    amount: Number(amount),
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
    freeShippingThreshold: threshold === undefined || threshold === null ? null : Number(threshold),
  };
}

module.exports = { lookupOrder, quoteShipping, stageOf };
