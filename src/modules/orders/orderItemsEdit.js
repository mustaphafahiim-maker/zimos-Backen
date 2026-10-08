'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const inventoryService = require('../inventory/inventoryService');
const discountService = require('../discounts/discountService');
const { calculateShippingAmount } = require('../shipping/shippingPricing');
const { calculateTax } = require('../tax/taxService');
const { recordAudit } = require('../audit/auditService');
const { assertNotShipped } = require('./shipmentLifecycle');
const orderService = require('./orderService');
const { applyBundleTiers } = require('../bundles/bundlePricing');
const staffPricing = require('./staffPricing');

/**
 * Editing an order's items before it ships (SPEC §4.4 "Editing"): add
 * products, change quantities, remove lines — with the price difference
 * shown before anything is saved.
 *
 * The request is the whole new list of lines. A line the order already has
 * (same variant and offer) keeps the price it was sold at, whatever the
 * catalogue says today; a new line is priced from the catalogue like any
 * order line. The order is then priced again as createOrder would price it:
 * quantity bundles on the new quantities (a product the edit leaves alone
 * keeps its bundle saving as sold), the discount code on the new
 * subtotal, shipping (weight, free-shipping threshold, the option the shopper
 * picked, free shipping the order was granted), tax, total. Stock follows in the same transaction — more is
 * reserved, less is released — and the invoice is brought to the new total.
 *
 * The preview is the same code run in a transaction that is rolled back, so
 * it cannot disagree with the save and it reports the same errors (out of
 * stock, a product no longer for sale).
 *
 * Refused on a cancelled order, once the parcel has left, and once money has
 * been received: a paid order is corrected with a refund, not by editing it.
 */

const keyOf = (line) => `${line.variantId}|${line.offerId || ''}`;

const totalsOf = (order) => ({
  subtotalAmount: String(order.subtotalAmount),
  discountAmount: String(order.discountAmount),
  shippingAmount: String(order.shippingAmount),
  taxAmount: String(order.taxAmount),
  totalAmount: String(order.totalAmount),
});

/** What a line holds in stock: its offer's lines × quantity, or its variant × quantity. */
async function consumedBy(workspaceId, line, transaction) {
  if (!line.variantId) return [];
  const facts = await orderService
    .priceLine(workspaceId, { variantId: line.variantId, offerId: line.offerId, quantity: line.quantity }, transaction, { forSale: false })
    .catch(() => null);
  return facts ? facts.consumedInventory : [{ variantId: line.variantId, quantity: line.quantity }];
}

// `manual`: { present, value } — the body's manualDiscount (item 382): left out keeps the order's, null removes it.
async function apply(workspaceId, orderId, requested, req, transaction, manual = { present: false, value: undefined }) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw new NotFoundError('Order');
  if (order.cancelledAt || order.confirmationState === 'rejected') {
    throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
  }
  await assertNotShipped(order, transaction);
  // A courier booking would still collect the old COD amount (item 352).
  await require('../shipping/carrierShipmentService').assertNoCarrierBooking(order.id, transaction);
  // A parcel carrying part of the order holds its lines and its own COD amount (item 375): editing would leave both stale.
  const splitParcel = await db.Shipment.findOne({
    where: { orderId: order.id, status: { [db.Sequelize.Op.notIn]: ['cancelled', 'returned'] }, items: { [db.Sequelize.Op.ne]: null } },
    attributes: ['id'],
    transaction,
  });
  if (splitParcel) {
    throw new AppError('ORDER_SPLIT_SHIPPED', 'Part of this order is in a parcel. Cancel its parcels before editing its items.', 409, { shipmentId: splitParcel.id });
  }
  if (Number(order.amountPaid) > 0) {
    throw new AppError('ORDER_ALREADY_PAID', 'This order has been paid; correct it with a refund instead of editing its items', 409);
  }

  const seen = new Set();
  for (const line of requested) {
    // A custom line (item 382) has no product to repeat; one the order has is named once only.
    if (staffPricing.isCustom(line)) {
      if (!line.orderItemId) continue;
      if (seen.has(`custom:${line.orderItemId}`)) throw new ValidationError([{ field: 'items.orderItemId', message: 'The same line appears twice' }]);
      seen.add(`custom:${line.orderItemId}`);
      continue;
    }
    if (seen.has(keyOf(line))) {
      throw new ValidationError([{ field: 'items', message: 'The same product and offer appears twice; change its quantity instead' }]);
    }
    seen.add(keyOf(line));
  }

  const existing = await db.OrderItem.findAll({ where: { orderId: order.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  const before = totalsOf(order);
  const beforeItems = existing.map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity, unitPriceAmount: String(i.unitPriceAmount) }));
  const existingByKey = new Map();
  for (const item of existing) if (item.variantId && !existingByKey.has(keyOf(item))) existingByKey.set(keyOf(item), item);
  // Lines with no variant: custom lines staff typed in (item 382), kept by naming their orderItemId.
  const customById = new Map(existing.filter((i) => !i.variantId).map((i) => [i.id, i]));

  // ---- staff price changes (item 382): a new or changed price, a custom line added or changed, the manual
  // discount set, changed or removed need orders.price_override; a quantity alone does not.
  const oldManual = staffPricing.manualOf(order);
  const customChanged = (wanted, kept) =>
    !kept ||
    kept.productNameSnapshot !== String(wanted.title).trim() ||
    Number(kept.unitPriceAmount) !== Number(wanted.unitPrice) ||
    (kept.skuSnapshot || null) !== (wanted.sku ? String(wanted.sku).trim() : null);
  const priceChanged = (wanted) => {
    if (staffPricing.isCustom(wanted)) return customChanged(wanted, wanted.orderItemId ? customById.get(wanted.orderItemId) : null);
    if (!staffPricing.hasUnitPrice(wanted)) return false;
    const kept = existingByKey.get(keyOf(wanted));
    return !kept || Number(kept.unitPriceAmount) !== Number(wanted.unitPrice);
  };
  const manualChanged = manual.present && !staffPricing.sameManual(manual.value, oldManual);
  // A custom line left out is removed: its price leaves the order, so that is a price change too.
  const keptCustomIds = new Set(requested.filter((w) => staffPricing.isCustom(w) && w.orderItemId).map((w) => w.orderItemId));
  const customRemoved = [...customById.keys()].some((id) => !keptCustomIds.has(id));
  const pricesTouched = requested.some(priceChanged) || manualChanged || customRemoved;
  if (pricesTouched && !staffPricing.canChangePrices(req)) throw staffPricing.forbidden();

  // ---- stock: what the order held, what it will hold
  const held = new Map();
  for (const item of existing) {
    for (const c of await consumedBy(workspaceId, item, transaction)) held.set(c.variantId, (held.get(c.variantId) || 0) + c.quantity);
  }

  // ---- the new lines
  const lines = [];
  for (const wanted of requested) {
    if (staffPricing.isCustom(wanted)) {
      const keptCustom = wanted.orderItemId ? customById.get(wanted.orderItemId) : null;
      if (wanted.orderItemId && !keptCustom) throw new ValidationError([{ field: 'items.orderItemId', message: 'Not a custom line of this order' }]);
      const line = staffPricing.customLine(wanted, req, keptCustom);
      line.currency = order.currency;
      // Re-sent without a weight, a kept line keeps the one it had.
      if (keptCustom && wanted.weightGrams === undefined && Number(keptCustom.unitWeightGrams) > 0) {
        line.weightUnits = [{ weightGrams: Number(keptCustom.unitWeightGrams), quantity: 1, weightless: false }];
      }
      // Changed: priced again by whoever changed it.
      if (keptCustom && customChanged(wanted, keptCustom)) line.priceOverride = staffPricing.customLine(wanted, req).priceOverride;
      line.priceChanged = !keptCustom || customChanged(wanted, keptCustom);
      lines.push(line);
      continue;
    }
    const kept = existingByKey.get(keyOf(wanted));
    if (kept) {
      const facts = await orderService
        .priceLine(workspaceId, wanted, transaction, { forSale: false })
        .catch(() => null);
      lines.push({
        kept,
        productId: kept.productId,
        // What decides whether a bundle tier covers the line (bundlePricing.applyBundleTiers).
        offerId: kept.offerId,
        isOrderBump: kept.isOrderBump,
        isUpsell: kept.isUpsell,
        // A free gift (freeGifts/, item 276) never unlocks a tier; recorded on the line since migration 513,
        // guessed for older lines from a labelled plain line at 0.
        freeGift: kept.isFreeGift !== null && kept.isFreeGift !== undefined
          ? kept.isFreeGift === true
          : !kept.offerId && Number(kept.unitPriceAmount) === 0 && Boolean(kept.offerNameSnapshot),
        quantity: wanted.quantity,
        unitPriceAmount: Number(kept.unitPriceAmount),
        // Full price here; the bundle tiers below take their saving off again (item 344), unless the product
        // is untouched (below).
        lineTotalAmount: Number(kept.unitPriceAmount) * wanted.quantity,
        lineDiscountAmount: 0,
        consumedInventory: facts ? facts.consumedInventory : [{ variantId: kept.variantId, quantity: wanted.quantity }],
        shippingOverride: facts ? facts.shippingOverride : null,
        weightUnits: facts
          ? facts.weightUnits
          : [{ weightGrams: kept.unitWeightGrams === null ? null : Number(kept.unitWeightGrams), quantity: 1, weightless: false }],
        shippingRule: facts ? facts.shippingRule : { mode: undefined, extraAmount: undefined, units: wanted.quantity },
      });
    } else {
      const priced = await orderService.priceLine(workspaceId, wanted, transaction);
      lines.push({ ...priced, kept: null, lineTotalAmount: Number(priced.lineTotalAmount) });
    }
    // Staff's own price (item 382). A kept line compares with the catalogue price it carries, or the price it sold at.
    const line = lines[lines.length - 1];
    line.priceOverride = kept ? kept.priceOverride || null : null;
    if (priceChanged(wanted)) {
      const catalog = kept ? (kept.priceOverride && kept.priceOverride.catalogUnitPriceAmount != null ? kept.priceOverride.catalogUnitPriceAmount : kept.unitPriceAmount) : line.unitPriceAmount;
      staffPricing.overrideLine(line, wanted.unitPrice, req, catalog);
      line.priceChanged = true;
    }
  }

  // ---- which products the edit touches: a line added, removed or with a new quantity. Lines of any other
  // product keep their stored price and bundle saving as sold, even if the bundle has changed or ended since
  // (item 344 review); a bundle entry of the order is priced again only when one of its products is touched.
  const touched = new Set();
  for (const line of lines) if (!line.kept || line.kept.quantity !== line.quantity || line.priceChanged) touched.add(line.productId);
  const keptItemIds = new Set(lines.filter((l) => l.kept).map((l) => l.kept.id));
  for (const item of existing) if (!keptItemIds.has(item.id)) touched.add(item.productId);
  const oldBundles = (order.discountsSnapshot || []).filter((d) => d && d.kind === 'bundle');
  const productsOf = (entry) => (Array.isArray(entry.productIds) ? entry.productIds : [entry.productId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of oldBundles) {
      if (productsOf(entry).some((id) => touched.has(id)) && !productsOf(entry).every((id) => touched.has(id))) {
        for (const id of productsOf(entry)) touched.add(id);
        grew = true;
      }
    }
  }

  for (const line of lines) {
    if (!line.kept || line.custom || touched.has(line.productId)) continue;
    line.frozen = true;
    line.lineTotalAmount = Number(line.kept.lineTotalAmount);
    line.lineDiscountAmount = Number(line.kept.lineDiscountAmount) || 0;
  }

  const wantedStock = new Map();
  for (const line of lines) {
    for (const c of line.consumedInventory) wantedStock.set(c.variantId, (wantedStock.get(c.variantId) || 0) + c.quantity);
  }
  const variantIds = [...new Set([...held.keys(), ...wantedStock.keys()])].sort();
  const actorUserId = req.user.id;
  for (const variantId of variantIds) {
    const delta = (wantedStock.get(variantId) || 0) - (held.get(variantId) || 0);
    const movement = { workspaceId, variantId, quantity: Math.abs(delta), referenceType: 'order_edited', referenceId: order.id, actorUserId };
    if (delta > 0) await inventoryService.reserve(movement, transaction);
    else if (delta < 0) await inventoryService.release(movement, transaction);
  }

  // ---- price the order again
  // Quantity bundles and mix-and-match boxes priced again on the new quantities, as createOrder prices them
  // (item 344); a quote's order keeps the merchant's exact prices (quotes/, item 275).
  const fromQuote = (await db.QuoteRequest.count({ where: { orderId: order.id, workspaceId }, transaction })) > 0;
  // A line at staff's own price takes no tier on top (item 382).
  const bundleSnapshots = fromQuote ? [] : await applyBundleTiers(workspaceId, lines.filter((l) => !l.frozen && !l.priceOverride), transaction);
  // The bundle entries of untouched products stay as sold, free shipping included.
  const keptBundles = oldBundles.filter((entry) => !productsOf(entry).some((id) => touched.has(id)));
  for (const entry of keptBundles) {
    if (entry.freeShipping !== true) continue;
    for (const line of lines) {
      if (line.frozen && line.shippingRule && productsOf(entry).includes(line.productId)) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
    }
  }
  // Free shipping a VIP tier, a referral or a pickup gave the order still holds (as for an added line, item 277).
  const keptShipping = order.shippingSnapshot || {};
  if (keptShipping.freeShippingGranted === true) {
    for (const line of lines) if (line.shippingRule) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
  }

  const subtotal = add(...lines.map((l) => l.lineTotalAmount));
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
  // A free-shipping code beats an offer's own shipping price (item 353 review).
  const offerShippingOverride = orderService.couponShipsFree(order) ? null : lines.find((l) => l.shippingOverride)?.shippingOverride || null;

  // The code's share, without staff's manual discount (item 382), which is worked out again below.
  let discountAmount = Number(order.discountAmount) - (oldManual ? Number(oldManual.amount) || 0 : 0);
  let discountsSnapshot = [
    ...keptBundles,
    ...bundleSnapshots,
    ...(order.discountsSnapshot || []).filter((d) => !d || (d.kind !== 'bundle' && d.kind !== staffPricing.MANUAL)),
  ];
  let redeemedDiscount = null;
  const redemption = await db.DiscountRedemption.findOne({ where: { orderId: order.id }, transaction });
  if (redemption) {
    const discount = await db.Discount.findByPk(redemption.discountId, { transaction });
    redeemedDiscount = discount;
    if (discount) {
      // Only the lines a product- or collection-limited code covers (item 345).
      discountAmount = await discountService.amountForLines(discount, lines, transaction);
      discountsSnapshot = discountsSnapshot.map((d) => (d.code === discount.code ? { ...d, amount: discountAmount } : d));
      await redemption.update({ amountAllocated: discountAmount }, { transaction });
    }
  } else {
    redeemedDiscount = await orderService.placedDiscount(order, transaction);
  }
  discountAmount = Math.min(discountAmount, subtotal);
  // Staff's manual discount on what the code leaves: the one asked for, or the order's own re-applied.
  const manualWanted = manual.present ? manual.value : oldManual;
  const manualDiscount = manualWanted
    ? staffPricing.manualEntry(manualWanted, subtotal - discountAmount, req, manualChanged ? null : oldManual)
    : null;
  if (manualDiscount) discountsSnapshot.push(manualDiscount);
  const couponAmount = discountAmount;
  discountAmount += manualDiscount ? manualDiscount.amount : 0;

  const address = order.shippingAddressSnapshot || null;
  // Shipping the merchant typed in by hand stays as typed.
  const manualShipping = order.shippingSnapshot && order.shippingSnapshot.rule === 'offer_override' && !offerShippingOverride;
  const shipping = await calculateShippingAmount(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    address,
    subtotal,
    totalQuantity,
    offerShippingOverride: manualShipping ? { amount: Number(order.shippingAmount) } : offerShippingOverride,
    weightLines: lines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
    productLines: lines.map((l) => l.shippingRule),
    // A funnel's order keeps the funnel's shipping group and currency rules (funnels/funnelShipping.js).
    funnelId: order.funnelId || null,
    transaction,
  });
  // The shipping option the shopper picked, at its price for the new order; standard when the store no
  // longer offers it (as for an added line, item 277). Shipping typed in by hand stays as typed.
  const option = !manualShipping && keptShipping.option && keptShipping.option.key
    ? await require('../shipping/shippingOptions').choose(workspaceId, keptShipping.option.key, shipping, transaction).catch(() => null)
    : null;
  const shippingAmount = option ? option.amount : shipping.amount;
  let { taxAmount } = await calculateTax(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    // Taxed after the order's discount, as createOrder taxes it (items 356, 382).
    lines: await staffPricing.taxableLines(lines, couponAmount, redeemedDiscount, manualDiscount ? manualDiscount.amount : 0, transaction),
    shippingAmount,
    transaction,
  });
  // Priced as an upsell joining the order is (item 317): a tax-exempt business order stays exempt, and the
  // payment method's own fee or discount is worked out again on the new amount instead of dropped.
  if (order.contactSnapshot && order.contactSnapshot.taxExempt === true) taxAmount = 0;
  const paymentAdjustment = await require('../payments/paymentRulesService').adjustmentForWorkspace(workspaceId, order.paymentMethod, subtotal - discountAmount + shippingAmount, transaction, order.currency);
  const totalAmount = subtotal - discountAmount + shippingAmount + taxAmount + paymentAdjustment.amount;

  // ---- write the lines
  const keptIds = new Set(lines.filter((l) => l.kept).map((l) => l.kept.id));
  for (const item of existing) {
    if (keptIds.has(item.id)) continue;
    await db.CustomerUpload.update({ orderItemId: null }, { where: { orderItemId: item.id }, transaction });
    await item.destroy({ transaction });
  }
  const items = [];
  for (const [index, line] of lines.entries()) {
    if (line.kept) {
      await line.kept.update(
        {
          quantity: line.quantity,
          lineDiscountAmount: line.lineDiscountAmount || 0,
          lineTotalAmount: line.lineTotalAmount,
          unitWeightGrams: shipping.lineWeights[index],
          // Staff's price and custom lines (item 382).
          unitPriceAmount: line.unitPriceAmount,
          priceOverride: line.priceOverride || null,
          ...(line.custom ? { productNameSnapshot: line.productName, skuSnapshot: line.sku } : {}),
        },
        { transaction }
      );
      items.push(line.kept);
    } else {
      items.push(
        await db.OrderItem.create(
          {
            orderId: order.id,
            productId: line.productId,
            variantId: line.variantId,
            offerId: line.offerId,
            productNameSnapshot: line.productName,
            variantOptionsSnapshot: line.variantOptions,
            skuSnapshot: line.sku,
            offerNameSnapshot: line.offerName,
            quantity: line.quantity,
            unitPriceAmount: line.unitPriceAmount,
            unitCostAmount: line.unitCostAmount,
            lineDiscountAmount: line.lineDiscountAmount || 0,
            lineTotalAmount: line.lineTotalAmount,
            unitWeightGrams: shipping.lineWeights[index],
            isFreeGift: false,
            priceOverride: line.priceOverride || null,
          },
          { transaction }
        )
      );
    }
  }

  await order.update(
    {
      subtotalAmount: subtotal,
      discountAmount,
      discountsSnapshot,
      shippingAmount,
      taxAmount,
      totalAmount,
      paymentAdjustmentAmount: paymentAdjustment.amount,
      paymentAdjustmentLabel: paymentAdjustment.label,
      // The total in the store's currency moves with the total (item 317): the reports convert with base / total.
      ...(await require('../currencies/fxService').baseFieldsFor(workspaceId, { currency: order.currency, totalAmount }, transaction)),
      totalWeightGrams: shipping.weightGrams,
      weightTierSnapshot: shipping.tier,
      weightEstimated: shipping.weightEstimated,
      // Only the option is re-priced; the delivery slot, pickup and granted free shipping stay (item 344).
      ...(keptShipping.option ? { shippingSnapshot: { ...keptShipping, option: option ? option.snapshot : undefined } } : {}),
    },
    { transaction }
  );

  const invoice = await db.Invoice.findOne({ where: { orderId: order.id }, order: [['issuedAt', 'DESC']], transaction });
  if (invoice) {
    await invoice.update(
      {
        totalAmount,
        lineItems: items.map((i) => ({
          name: i.productNameSnapshot,
          quantity: i.quantity,
          unitPriceAmount: i.unitPriceAmount,
          lineTotalAmount: i.lineTotalAmount,
        })),
      },
      { transaction }
    );
  }

  const after = totalsOf(order);
  await recordAudit({
    workspaceId,
    actorUserId,
    action: 'order.items_update',
    entityType: 'Order',
    entityId: order.id,
    before: { ...before, items: beforeItems, manualDiscount: oldManual },
    after: { ...after, items: items.map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity, unitPriceAmount: String(i.unitPriceAmount) })), manualDiscount },
    req,
    transaction,
  });
  // Staff price changes on their own line of the log too (item 382), as on a new order.
  if (pricesTouched) {
    await recordAudit({
      workspaceId,
      actorUserId,
      action: 'order.price_change',
      entityType: 'Order',
      entityId: order.id,
      before: { items: beforeItems, manualDiscount: oldManual },
      after: {
        items: items.map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity, unitPriceAmount: String(i.unitPriceAmount), ...staffPricing.presentLine(i) })),
        manualDiscount,
      },
      req,
      transaction,
    });
  }

  return {
    currency: order.currency,
    before,
    after,
    differenceAmount: String(Number(after.totalAmount) - Number(before.totalAmount)),
    // Staff's manual discount apart from the code (item 382); after.discountAmount is both together.
    manualDiscount,
    items: items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      offerId: i.offerId,
      name: i.productNameSnapshot,
      options: i.variantOptionsSnapshot,
      offerName: i.offerNameSnapshot,
      quantity: i.quantity,
      unitPriceAmount: String(i.unitPriceAmount),
      lineTotalAmount: String(i.lineTotalAmount),
      sku: i.skuSnapshot,
      ...staffPricing.presentLine(i),
    })),
  };
}

class PreviewDone extends Error {
  constructor(result) {
    super('preview');
    this.result = result;
  }
}

/** POST /orders/:id/items/preview — what saving would do, saved nowhere. */
const manualOfBody = (body) => ({ present: body.manualDiscount !== undefined, value: body.manualDiscount === undefined ? undefined : body.manualDiscount });

async function previewItems(workspaceId, orderId, body, req) {
  try {
    await db.sequelize.transaction(async (transaction) => {
      throw new PreviewDone(await apply(workspaceId, orderId, body.items, req, transaction, manualOfBody(body)));
    });
  } catch (err) {
    if (err instanceof PreviewDone) return err.result;
    throw err;
  }
  throw new Error('unreachable');
}

/** PUT /orders/:id/items */
async function updateItems(workspaceId, orderId, body, req) {
  await db.sequelize.transaction((transaction) => apply(workspaceId, orderId, body.items, req, transaction, manualOfBody(body)));
  return orderService.getOrder(workspaceId, orderId);
}

/**
 * POST /orders/:id/refund-quote — the amount a refund of these lines comes
 * to: each line's price for the units returned, less its share of the
 * order's discount (only the lines a product- or collection-limited code
 * covered take a share of it). Shipping is not included. The merchant may still change
 * the amount before refunding (POST /orders/:id/refunds does the refund).
 */
async function refundQuote(workspaceId, orderId, { lines }) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
  if (!order) throw new NotFoundError('Order');
  const byId = new Map(order.items.map((i) => [i.id, i]));
  let subtotal = Number(order.subtotalAmount);
  // Staff's manual discount (item 382) was spread over every line; the code's over its covered lines.
  const fullSubtotal = subtotal;
  const manual = staffPricing.manualOf(order);
  const manualAmount = manual ? Number(manual.amount) || 0 : 0;
  const discount = Math.max(0, Number(order.discountAmount) - manualAmount);
  // A product- or collection-limited code was taken off its covered lines
  // only (item 345), so only those lines give a share of it back.
  let covered = null;
  const redemption = discount > 0 ? await db.DiscountRedemption.findOne({ where: { orderId: order.id } }) : null;
  const code = redemption ? await db.Discount.findByPk(redemption.discountId) : null;
  if (code) {
    const priced = order.items.filter((i) => !i.isFreeGift);
    const eligible = await discountService.eligibleProducts(code, priced.map((i) => i.productId));
    const base = eligible ? discountService.eligibleSubtotal(eligible, priced, 0) : 0;
    if (eligible && base > 0) {
      covered = new Set(priced.filter((i) => eligible.has(i.productId)).map((i) => i.id));
      subtotal = base;
    }
  }
  let amount = 0;
  const out = [];
  for (const line of lines) {
    const item = byId.get(line.orderItemId);
    if (!item) throw new ValidationError([{ field: 'lines.orderItemId', message: 'Order item is not on this order' }]);
    if (line.quantity > item.quantity) {
      throw new ValidationError([{ field: 'lines.quantity', message: `At most ${item.quantity} can be refunded for this line` }]);
    }
    const gross = Number(item.unitPriceAmount) * line.quantity;
    const share =
      (subtotal > 0 && (!covered || covered.has(item.id)) ? Math.round((discount * gross) / subtotal) : 0) +
      (fullSubtotal > 0 ? Math.round((manualAmount * gross) / fullSubtotal) : 0);
    amount += gross - share;
    out.push({ orderItemId: item.id, name: item.productNameSnapshot, quantity: line.quantity, amount: String(gross - share) });
  }
  const refundable = Math.max(0, Number(order.amountPaid) - Number(order.amountRefunded));
  return { currency: order.currency, amount: String(amount), refundableAmount: String(refundable), lines: out };
}

module.exports = { previewItems, updateItems, refundQuote };
