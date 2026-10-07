'use strict';

const db = require('../../db/models');
const { applyBasisPoints } = require('../../core/utils/money');
const { AppError } = require('../../core/errors/AppError');

/**
 * Validates a discount code against a priced cart and returns the discount
 * amount (in minor units) to apply, WITHOUT redeeming it yet. Redemption
 * (which enforces usage limits atomically) happens in redeem(), called
 * inside the same order-creation transaction so a usage-limit check and the
 * increment that enforces it can never race. `transaction` is that order
 * transaction, so these reads do not need a second pooled connection.
 *
 * `lines` ([{ productId, lineTotalAmount, freeGift? }]) are the priced lines:
 * a code limited to some products or collections takes its percentage (or
 * caps its fixed amount) on those lines only (item 345). Without them the
 * whole subtotal is used.
 */
async function evaluate(workspaceId, code, { subtotal, productIds, lines = null, customerId, funnelId, transaction }) {
  if (!code) return { discount: null, amount: 0 };

  const discount = await db.Discount.findOne({ where: { workspaceId, code, status: 'active' }, transaction });
  if (!discount) throw new AppError('INVALID_DISCOUNT_CODE', 'Discount code is invalid', 422);

  const now = new Date();
  if (discount.startsAt && discount.startsAt > now) throw new AppError('DISCOUNT_NOT_STARTED', 'Discount code is not yet active', 422);
  if (discount.endsAt && discount.endsAt < now) throw new AppError('DISCOUNT_EXPIRED', 'Discount code has expired', 422);
  if (discount.minimumSubtotal && subtotal < discount.minimumSubtotal) {
    throw new AppError('DISCOUNT_MINIMUM_NOT_MET', 'Order subtotal does not meet the discount minimum', 422);
  }
  const eligible = await eligibleProducts(discount, productIds, transaction);
  if (eligible && eligible.size === 0) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to items in this order', 422);
  }
  if (discount.funnelRestrictions.length && (!funnelId || !discount.funnelRestrictions.includes(funnelId))) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to this funnel', 422);
  }
  // A personal code: only the customers it was made for. An unknown shopper
  // (the storefront's preview) is checked when the order is placed.
  if ((discount.customerRestrictions || []).length && customerId && !discount.customerRestrictions.includes(customerId)) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to this customer', 422);
  }
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new AppError('DISCOUNT_USAGE_LIMIT_REACHED', 'Discount code has reached its usage limit', 422);
  }
  if (discount.perCustomerLimit !== null && customerId) {
    const used = await db.DiscountRedemption.count({ where: { discountId: discount.id, customerId }, transaction });
    if (used >= discount.perCustomerLimit) {
      throw new AppError('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED', 'You have already used this discount code', 422);
    }
  }

  return { discount, amount: amountFor(discount, eligibleSubtotal(eligible, lines, subtotal)) };
}

/**
 * The products of `productIds` a product- or collection-limited discount
 * covers: in its product list, or linked to one of its collections (smart
 * collections keep their links in product_collections too). null when the
 * discount is not limited, so it covers the whole order.
 */
async function eligibleProducts(discount, productIds, transaction) {
  const products = discount.productRestrictions || [];
  const collections = discount.collectionRestrictions || [];
  if (!products.length && !collections.length) return null;
  const eligible = new Set((productIds || []).filter((id) => products.includes(id)));
  const rest = [...new Set(productIds || [])].filter((id) => !eligible.has(id));
  if (collections.length && rest.length) {
    const links = await db.ProductCollection.findAll({
      where: { productId: rest, collectionId: collections },
      attributes: ['productId'],
      raw: true,
      transaction,
    });
    for (const link of links) eligible.add(link.productId);
  }
  return eligible;
}

/** The part of the order a limited discount works on: its covered lines' totals (free gifts never count). */
function eligibleSubtotal(eligible, lines, subtotal) {
  if (!eligible || !Array.isArray(lines)) return subtotal;
  return lines.filter((l) => !l.freeGift && eligible.has(l.productId)).reduce((sum, l) => sum + Number(l.lineTotalAmount), 0);
}

/**
 * amountFor on priced lines: the whole subtotal, or only the covered lines'
 * for a product- or collection-limited discount. For an order whose lines
 * change after the code was redeemed (items edited, an upsell joined).
 */
async function amountForLines(discount, lines, transaction) {
  const subtotal = lines.reduce((sum, l) => sum + Number(l.lineTotalAmount), 0);
  const eligible = await eligibleProducts(discount, lines.filter((l) => !l.freeGift).map((l) => l.productId), transaction);
  return amountFor(discount, eligibleSubtotal(eligible, lines, subtotal));
}

/**
 * What a code takes off `subtotal`. free_shipping and buy_x_get_y are applied
 * by the caller against shipping/line totals respectively using
 * discount.buyXGetYConfig; this only covers the subtotal-level percentage /
 * fixed cases. Also used when an order's subtotal changes after the code was
 * redeemed (an upsell joined to it), so the same code is not checked again.
 */
function amountFor(discount, subtotal) {
  if (discount.type === 'percentage') return applyBasisPoints(subtotal, discount.value);
  if (discount.type === 'fixed') return Math.min(Number(discount.value), subtotal);
  return 0;
}

/**
 * Redeems a discount inside the caller's transaction: increments usageCount
 * and inserts a DiscountRedemption row, using SELECT ... FOR UPDATE on the
 * discount row so two concurrent checkouts racing for the last remaining
 * use of a limited discount cannot both succeed.
 *
 * `allowOverLimit` is for a prepaid order redeemed only once its payment is
 * confirmed (orders/orderCompletion.js): the code was valid when the shopper
 * placed the order and they were charged the discounted price, so the use is
 * recorded even if the limit ran out while they were paying.
 */
async function redeem(discountId, { orderId, customerId, amountAllocated }, transaction, { allowOverLimit = false } = {}) {
  const discount = await db.Discount.findByPk(discountId, { lock: transaction.LOCK.UPDATE, transaction });
  if (!allowOverLimit && discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new AppError('DISCOUNT_USAGE_LIMIT_REACHED', 'Discount code has reached its usage limit', 422);
  }
  await discount.update({ usageCount: discount.usageCount + 1 }, { transaction });
  await db.DiscountRedemption.create(
    { workspaceId: discount.workspaceId, discountId, orderId, customerId, amountAllocated },
    { transaction }
  );
}

module.exports = { evaluate, redeem, amountFor, amountForLines, eligibleProducts, eligibleSubtotal };
