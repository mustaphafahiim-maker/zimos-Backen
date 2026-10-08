'use strict';

const db = require('../../db/models');
const { normalizePhone } = require('../../core/utils/phone');
const { GOVERNORATES } = require('../shipping/governorates');
const orderService = require('./orderService');

/**
 * What the dashboard's "Create order" screen needs around POST /orders
 * (SPEC §4.5): find the customer by phone, and see the price before saving.
 */

/** Rolled back on purpose: carries the priced order out of the transaction. */
class PreviewDone extends Error {
  constructor(result) {
    super('preview');
    this.result = result;
  }
}

/**
 * Prices a manual order exactly as POST /orders would — the same function,
 * run inside a transaction that is then rolled back, so nothing is created,
 * reserved or numbered and the preview can never disagree with the order.
 * Errors the real order would raise (out of stock, unknown code, a product
 * that is no longer for sale) are raised here too.
 */
async function preview(workspaceId, payload, req) {
  const body = {
    ...payload,
    // A preview may come before the customer is typed in.
    contact: payload.contact && payload.contact.phone ? payload.contact : { fullName: 'Preview', phone: '01000000000' },
  };
  try {
    await db.sequelize.transaction(async (transaction) => {
      const { order, items } = await orderService.createOrder(workspaceId, body, req, {
        transaction,
        shippingOverride: shippingOverrideOf(payload),
      });
      throw new PreviewDone({
        currency: order.currency,
        subtotalAmount: String(order.subtotalAmount),
        discountAmount: String(order.discountAmount),
        shippingAmount: String(order.shippingAmount),
        taxAmount: String(order.taxAmount),
        totalAmount: String(order.totalAmount),
        shippingSnapshot: order.shippingSnapshot,
        // Staff's manual discount apart from the code (item 382); discountAmount is both together.
        discountsSnapshot: order.discountsSnapshot,
        manualDiscount: require('./staffPricing').manualOf(order),
        items: items.map((i) => ({
          variantId: i.variantId,
          offerId: i.offerId,
          name: i.productNameSnapshot,
          options: i.variantOptionsSnapshot,
          offerName: i.offerNameSnapshot,
          quantity: i.quantity,
          unitPriceAmount: String(i.unitPriceAmount),
          lineTotalAmount: String(i.lineTotalAmount),
          sku: i.skuSnapshot,
          // A custom line, or a catalogue line at staff's price with the catalogue's to compare (item 382).
          ...require('./staffPricing').presentLine(i),
        })),
      });
    });
  } catch (err) {
    if (err instanceof PreviewDone) return err.result;
    throw err;
  }
  throw new Error('unreachable');
}

/** `shippingAmount` typed by staff replaces the calculated shipping. */
function shippingOverrideOf(payload) {
  return payload.shippingAmount === undefined || payload.shippingAmount === null ? null : { amount: payload.shippingAmount };
}

/**
 * The customer behind a phone number, with their last address and how their
 * orders went — or null. Any spelling of the number finds them.
 */
async function customerByPhone(workspaceId, phone) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;
  const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized } });
  if (!customer) return null;
  const lastOrder = await db.Order.findOne({
    where: { workspaceId, customerId: customer.id },
    order: [['createdAt', 'DESC']],
    attributes: ['id', 'orderNumber', 'shippingAddressSnapshot', 'contactSnapshot', 'createdAt'],
  });
  return {
    id: customer.id,
    fullName: customer.fullName,
    phone: customer.phoneRaw || phone,
    alternatePhone: customer.alternatePhone,
    email: customer.email,
    isBlacklisted: customer.isBlacklisted,
    totalOrders: customer.totalOrders || 0,
    totalRejectedOrders: customer.totalRejectedOrders || 0,
    lastAddress: lastOrder ? lastOrder.shippingAddressSnapshot : null,
    lastOrder: lastOrder ? { id: lastOrder.id, orderNumber: lastOrder.orderNumber, createdAt: lastOrder.createdAt } : null,
  };
}

function options() {
  return { governorates: GOVERNORATES.map((g) => ({ code: g.code, ar: g.ar, en: g.en })) };
}

module.exports = { preview, customerByPhone, options, shippingOverrideOf };
