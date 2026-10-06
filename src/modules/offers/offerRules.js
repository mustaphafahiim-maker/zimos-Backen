'use strict';

const Joi = require('joi');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { presentBump, assertBumpOfferUsable, orderBumpUnavailable } = require('../checkout/orderBump');
const { loadPublicProducts } = require('../storefront/publicProduct');

/*
 * The offer rules of SPEC §10.2–10.4:
 *
 *   order bumps      up to MAX_BUMPS tick boxes on a product's order form
 *   cross-sell       products suggested beside what is in the cart / order
 *   upsell           one offer on the thank-you page, added to the same
 *                    cash-on-delivery order with one tap
 *   exit downsell    a popup with a coupon when the shopper is about to leave
 *
 * A bump and an upsell sell an existing Offer, so their price is the offer's
 * price, set by the merchant and read by the server — the browser only ever
 * names the offer. Nothing here invents urgency: no fake timers or counters.
 */

const { Op } = db.Sequelize;
const MAX_BUMPS = 3;
// 'product': the product page (boughtTogether/, item 223).
const PLACEMENTS = ['cart', 'checkout', 'thank_you', 'product'];
const UPSELL_WINDOW_MINUTES = 30;
const EXIT_KEY = 'exit_downsell';

const uuid = Joi.string().uuid();
const text = (max) => Joi.string().trim().max(max).allow('', null);
const ids = (max) => Joi.array().items(uuid).max(max).unique();

const schemas = {
  bump: Joi.object({
    productId: uuid.allow(null).default(null),
    offerId: uuid.required(),
    headline: text(120),
    description: text(300),
    preChecked: Joi.boolean().default(false),
    position: Joi.number().integer().min(0).max(1000).default(0),
    isActive: Joi.boolean().default(true),
  }),
  crossSell: Joi.object({
    name: Joi.string().trim().min(1).max(120).required(),
    triggerProductIds: ids(100).default([]),
    triggerCollectionIds: ids(50).default([]),
    offerProductIds: ids(20).min(1).required(),
    placement: Joi.string()
      .valid(...PLACEMENTS)
      .default('cart'),
    maxItems: Joi.number().integer().min(1).max(8).default(4),
    isActive: Joi.boolean().default(true),
  }),
  upsell: Joi.object({
    triggerProductId: uuid.allow(null).default(null),
    offerId: uuid.required(),
    headline: text(120),
    description: text(300),
    position: Joi.number().integer().min(0).max(1000).default(0),
    isActive: Joi.boolean().default(true),
  }),
  exitDownsell: Joi.object({
    enabled: Joi.boolean().required(),
    trigger: Joi.string().valid('exit_intent', 'delay').default('exit_intent'),
    delaySeconds: Joi.number().integer().min(3).max(600).default(30),
    title: text(120),
    message: text(300),
    discountId: uuid.allow(null).default(null),
    pages: Joi.string().valid('product', 'cart', 'all').default('all'),
  }),
};

const blankToNull = (data, keys) => {
  const out = { ...data };
  for (const key of keys) if (out[key] === '') out[key] = null;
  return out;
};

async function audit(workspaceId, req, action, entityType, entityId, before, after) {
  await recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType, entityId, before, after, req });
}

async function assertProduct(workspaceId, productId, field) {
  if (!productId) return;
  const found = await db.Product.count({ where: { id: productId, workspaceId } });
  if (!found) throw new ValidationError([{ field, message: 'Unknown product' }]);
}

/** Offer and product names for a list of rules, so the dashboard can show them. */
async function decorate(workspaceId, rows, productKey) {
  const offers = await db.Offer.findAll({
    where: { workspaceId, id: [...new Set(rows.map((r) => r.offerId))] },
    attributes: ['id', 'name', 'priceAmount', 'currency', 'status'],
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'status'] }],
  });
  const products = await db.Product.findAll({
    where: { workspaceId, id: [...new Set(rows.map((r) => r[productKey]).filter(Boolean))] },
    attributes: ['id', 'name'],
  });
  const offerOf = new Map(offers.map((o) => [o.id, o]));
  const productOf = new Map(products.map((p) => [p.id, p]));
  return rows.map((row) => {
    const offer = offerOf.get(row.offerId);
    return {
      ...row.toJSON(),
      offer: offer
        ? {
            id: offer.id,
            name: offer.name,
            priceAmount: Number(offer.priceAmount),
            currency: offer.currency,
            productName: offer.product ? offer.product.name : null,
            usable: offer.status === 'active' && Boolean(offer.product) && offer.product.status === 'active',
          }
        : null,
      product: row[productKey] ? productOf.get(row[productKey]) || null : null,
    };
  });
}

// ------------------------------------------------------------ order bumps --

async function listBumps(workspaceId) {
  const rows = await db.OrderBump.findAll({
    where: { workspaceId },
    order: [
      ['productId', 'ASC'],
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });
  return decorate(workspaceId, rows, 'productId');
}

/** At most MAX_BUMPS active bumps on one product (and MAX_BUMPS store-wide ones). */
async function assertBumpRoom(workspaceId, productId, exceptId) {
  const count = await db.OrderBump.count({
    where: { workspaceId, productId: productId || null, isActive: true, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
  });
  if (count >= MAX_BUMPS) {
    throw new AppError('ORDER_BUMP_LIMIT', `A product can have at most ${MAX_BUMPS} active order bumps`, 409, [
      { field: 'productId', message: `At most ${MAX_BUMPS} active order bumps` },
    ]);
  }
}

async function assertBumpNotOwnProduct(workspaceId, offerId, productId, field) {
  if (!productId) return;
  const offer = await db.Offer.findOne({ where: { id: offerId, workspaceId }, attributes: ['productId'] });
  if (offer && offer.productId === productId) {
    throw new ValidationError([{ field, message: 'Choose an offer of another product: this one is the product itself' }]);
  }
}

async function saveBump(workspaceId, bumpId, body, req) {
  const data = blankToNull(body, ['headline', 'description']);
  const existing = bumpId ? await db.OrderBump.findOne({ where: { id: bumpId, workspaceId } }) : null;
  if (bumpId && !existing) throw new NotFoundError('OrderBump');
  await assertProduct(workspaceId, data.productId, 'productId');
  await assertBumpOfferUsable(workspaceId, data.offerId, 'offerId');
  await assertBumpNotOwnProduct(workspaceId, data.offerId, data.productId, 'offerId');
  if (data.isActive) await assertBumpRoom(workspaceId, data.productId, bumpId);
  const before = existing ? existing.toJSON() : null;
  const row = existing ? await existing.update(data) : await db.OrderBump.create({ ...data, workspaceId });
  await audit(workspaceId, req, existing ? 'order_bump.update' : 'order_bump.create', 'OrderBump', row.id, before, row.toJSON());
  return (await decorate(workspaceId, [row], 'productId'))[0];
}

async function deleteRule(model, entityType, action, workspaceId, id, req) {
  const row = await model.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError(entityType);
  const before = row.toJSON();
  await row.destroy();
  await audit(workspaceId, req, action, entityType, id, before, null);
  return { deleted: true, id };
}

/** Active bump rules that apply to any of `productIds`: the product's own first, then store-wide. */
async function bumpRulesFor(workspaceId, productIds) {
  const rows = await db.OrderBump.findAll({
    where: { workspaceId, isActive: true, [Op.or]: [{ productId: null }, { productId: productIds }] },
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });
  return [...rows.filter((r) => r.productId), ...rows.filter((r) => !r.productId)];
}

/** The bump cards of a product page, at most MAX_BUMPS, never the product itself. */
async function publicBumpsForProduct(workspaceId, productId) {
  const cards = [];
  const seen = new Set();
  for (const rule of await bumpRulesFor(workspaceId, [productId])) {
    if (cards.length >= MAX_BUMPS) break;
    if (seen.has(rule.offerId)) continue;
    seen.add(rule.offerId);
    const card = await presentBump(workspaceId, rule.offerId, { title: rule.headline, description: rule.description });
    if (!card || card.productId === productId) continue;
    cards.push({ ...card, id: rule.id, preChecked: rule.preChecked });
  }
  return cards;
}

/**
 * Order lines for the bumps the shopper ticked. Each must be a bump offered
 * with one of the products being bought (422 ORDER_BUMP_INVALID otherwise)
 * and still sellable (409 ORDER_BUMP_UNAVAILABLE).
 */
async function resolveBumpItems(workspace, offerIds, items) {
  const wanted = [...new Set(offerIds)].slice(0, MAX_BUMPS);
  if (wanted.length === 0) return [];
  const variants = await db.ProductVariant.findAll({
    where: { workspaceId: workspace.id, id: items.map((i) => i.variantId).filter(Boolean) },
    attributes: ['productId'],
  });
  const productIds = [...new Set(variants.map((v) => v.productId))];
  const allowed = new Set((await bumpRulesFor(workspace.id, productIds)).map((r) => r.offerId));
  // An add-on joins the order in its own money only: one priced in another currency (a
  // funnel selling in dollars, a bump in pounds) is not offered there (SPEC §11.5).
  const currency = await require('../payments/methodCurrency').itemsCurrency(workspace.id, items);
  const lines = [];
  for (const offerId of wanted) {
    if (!allowed.has(offerId)) {
      throw new AppError('ORDER_BUMP_INVALID', 'This add-on is not offered with this order', 422, [
        { field: 'orderBumps.offerId', message: 'Not an order bump of these products' },
      ]);
    }
    const card = await presentBump(workspace.id, offerId);
    if (!card || (currency && card.currency && card.currency !== currency)) throw orderBumpUnavailable();
    lines.push({ variantId: card.variantId, offerId, quantity: 1, isOrderBump: true });
  }
  return lines;
}

// -------------------------------------------------------------- cross-sell --

async function listCrossSell(workspaceId) {
  return db.CrossSellRule.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
}

async function saveCrossSell(workspaceId, ruleId, data, req) {
  const existing = ruleId ? await db.CrossSellRule.findOne({ where: { id: ruleId, workspaceId } }) : null;
  if (ruleId && !existing) throw new NotFoundError('CrossSellRule');
  const productIds = [...new Set([...data.triggerProductIds, ...data.offerProductIds])];
  const found = await db.Product.count({ where: { workspaceId, id: productIds } });
  if (found !== productIds.length) throw new ValidationError([{ field: 'offerProductIds', message: 'Unknown product' }]);
  if (data.triggerCollectionIds.length > 0) {
    const collections = await db.Collection.count({ where: { workspaceId, id: data.triggerCollectionIds } });
    if (collections !== data.triggerCollectionIds.length) {
      throw new ValidationError([{ field: 'triggerCollectionIds', message: 'Unknown collection' }]);
    }
  }
  const before = existing ? existing.toJSON() : null;
  const row = existing ? await existing.update(data) : await db.CrossSellRule.create({ ...data, workspaceId });
  await audit(workspaceId, req, existing ? 'cross_sell.update' : 'cross_sell.create', 'CrossSellRule', row.id, before, row.toJSON());
  return row;
}

/** Products most often bought in the same order as `productIds`: the nightly pairs, with the store's exclusions (boughtTogether/, item 223). */
async function boughtTogether(workspaceId, productIds, limit) {
  return require('../boughtTogether').suggest(workspaceId, productIds, limit);
}

/**
 * What to suggest beside `productIds` at `placement`: the merchant's first
 * matching rule, else what real orders show was bought together. Never a
 * product already in the cart; hidden and inactive products are left out.
 */
async function suggestCrossSell(workspaceId, productIds, placement) {
  if (productIds.length === 0) return { source: null, products: [] };
  const rules = await db.CrossSellRule.findAll({
    where: { workspaceId, isActive: true, placement },
    order: [['createdAt', 'ASC']],
  });
  let collectionIds = null;
  let chosen = null;
  for (const rule of rules) {
    const triggers = rule.triggerProductIds || [];
    const triggerCollections = rule.triggerCollectionIds || [];
    let matches = triggers.length === 0 && triggerCollections.length === 0;
    if (!matches && triggers.some((id) => productIds.includes(id))) matches = true;
    if (!matches && triggerCollections.length > 0) {
      if (!collectionIds) {
        const links = await db.ProductCollection.findAll({ where: { productId: productIds }, attributes: ['collectionId'] });
        collectionIds = links.map((l) => l.collectionId);
      }
      matches = triggerCollections.some((id) => collectionIds.includes(id));
    }
    if (matches) {
      chosen = rule;
      break;
    }
  }
  const limit = chosen ? chosen.maxItems : 4;
  const candidates = chosen
    ? (chosen.offerProductIds || []).filter((id) => !productIds.includes(id))
    : await boughtTogether(workspaceId, productIds, limit);
  const products = (await loadPublicProducts(workspaceId, candidates))
    .filter((p) => !p.pageSettings.hidden && p.variants.some((v) => v.inStock))
    .slice(0, limit);
  // ruleId: what the strip's impressions and add-to-carts are counted under (offerStats.js).
  return { source: chosen ? 'rule' : products.length > 0 ? 'bought_together' : null, ruleId: chosen ? chosen.id : null, products };
}

// ------------------------------------------------------ post-purchase upsell --

async function listUpsells(workspaceId) {
  const rows = await db.UpsellRule.findAll({
    where: { workspaceId },
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });
  return decorate(workspaceId, rows, 'triggerProductId');
}

async function saveUpsell(workspaceId, ruleId, body, req) {
  const data = blankToNull(body, ['headline', 'description']);
  const existing = ruleId ? await db.UpsellRule.findOne({ where: { id: ruleId, workspaceId } }) : null;
  if (ruleId && !existing) throw new NotFoundError('UpsellRule');
  await assertProduct(workspaceId, data.triggerProductId, 'triggerProductId');
  await assertBumpOfferUsable(workspaceId, data.offerId, 'offerId');
  const before = existing ? existing.toJSON() : null;
  const row = existing ? await existing.update(data) : await db.UpsellRule.create({ ...data, workspaceId });
  await audit(workspaceId, req, existing ? 'upsell_rule.update' : 'upsell_rule.create', 'UpsellRule', row.id, before, row.toJSON());
  return (await decorate(workspaceId, [row], 'triggerProductId'))[0];
}

/** Whether one more line may still join the order: cash on delivery, untouched, placed minutes ago. */
async function orderOpenForUpsell(order, transaction) {
  if (order.paymentMethod !== 'cod' || order.cancelledAt) return false;
  if (order.confirmationState !== 'pending' || order.fulfillmentState !== 'unfulfilled') return false;
  if (order.financialState !== 'pending' || Number(order.amountPaid) > 0) return false;
  if (Date.now() - new Date(order.createdAt).getTime() > UPSELL_WINDOW_MINUTES * 60 * 1000) return false;
  const shipments = await db.Shipment.count({ where: { orderId: order.id }, transaction });
  if (shipments > 0) return false;
  // An agent who has already opened the order sees the lines they will read out.
  const taken = await db.ConfirmationTask.count({
    where: { orderId: order.id, status: { [Op.ne]: 'queued' } },
    transaction,
  });
  return taken === 0;
}

/** The order named by its id and its number together: neither alone opens it. */
async function findShopperOrder(workspaceId, orderId, orderNumber, options = {}) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId, orderNumber }, ...options });
  if (!order) throw new NotFoundError('Order');
  return order;
}

/** The first rule whose offer can be shown for an order holding `productIds`. */
async function upsellFor(workspaceId, productIds) {
  const rules = await db.UpsellRule.findAll({
    where: { workspaceId, isActive: true, [Op.or]: [{ triggerProductId: null }, { triggerProductId: productIds }] },
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });
  for (const rule of [...rules.filter((r) => r.triggerProductId), ...rules.filter((r) => !r.triggerProductId)]) {
    const card = await presentBump(workspaceId, rule.offerId, { title: rule.headline, description: rule.description });
    if (card && !productIds.includes(card.productId)) return { rule, card };
  }
  return null;
}

async function orderProductIds(orderId, transaction) {
  const items = await db.OrderItem.findAll({ where: { orderId }, attributes: ['productId'], transaction });
  return [...new Set(items.map((i) => i.productId).filter(Boolean))];
}

/** GET: the upsell to show on this order's thank-you page, or null. */
async function publicUpsell(workspaceId, orderId, orderNumber) {
  const order = await findShopperOrder(workspaceId, orderId, orderNumber);
  // Cash on delivery: one more line on the order. Paid online: a linked order (upsellFollowOn.js).
  const followOn = require('./upsellFollowOn').paidOnlineOpen(order, UPSELL_WINDOW_MINUTES);
  if (!followOn && !(await orderOpenForUpsell(order))) return null;
  if (await db.UpsellAcceptance.count({ where: { orderId: order.id } })) return null;
  const match = await upsellFor(workspaceId, await orderProductIds(order.id));
  if (!match) return null;
  // The real countdown runs from the order (offers/offerCountdown.js); an ended one is not shown.
  const offer = await db.Offer.findByPk(match.card.offerId, { attributes: ['id', 'countdownMinutes'] });
  const expiresAt = require('./offerCountdown').deadline(offer, order.createdAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) return null;
  return { ...match.card, ruleId: match.rule.id, countdownMinutes: (offer && offer.countdownMinutes) || null, expiresAt, followOn };
}

/**
 * POST: takes the upsell's offer, once — added to a cash-on-delivery order, or
 * as a linked order after one paid online (upsellFollowOn.js), charged in one
 * click to a card the shopper saved.
 */
async function acceptUpsell(workspaceId, orderId, orderNumber, offerId, variantId = null) {
  const orderService = require('../orders/orderService');
  const followOns = require('./upsellFollowOn');
  let charge = null;
  try {
    const result = await db.sequelize.transaction(async (transaction) => {
      const order = await findShopperOrder(workspaceId, orderId, orderNumber, { transaction, lock: transaction.LOCK.UPDATE });
      const closed = () => new AppError('UPSELL_CLOSED', 'This order can no longer be added to', 409);
      const asFollowOn = followOns.paidOnlineOpen(order, UPSELL_WINDOW_MINUTES);
      if (!asFollowOn && !(await orderOpenForUpsell(order, transaction))) throw closed();
      if (await db.UpsellAcceptance.count({ where: { orderId: order.id }, transaction })) throw closed();
      const match = await upsellFor(workspaceId, await orderProductIds(order.id, transaction));
      if (!match || match.card.offerId !== offerId) {
        throw new AppError('UPSELL_INVALID', 'This offer is not available for this order', 422);
      }
      // In the variant the shopper chose (offers/offerVariantChoice.js).
      const offer = await db.Offer.findOne({ where: { id: offerId, workspaceId }, include: [{ model: db.OfferVariant, as: 'lines' }], transaction });
      const countdown = require('./offerCountdown');
      countdown.assertOpen(offer, order.createdAt, countdown.upsellExpired);
      const line = offer ? await require('./offerVariantChoice').offerLineFor(offer, variantId, transaction) : { variantId: match.card.variantId, offerId, quantity: 1 };

      if (asFollowOn) {
        const made = await followOns.createFollowOn(workspaceId, order, line, transaction);
        await db.UpsellAcceptance.create(
          { workspaceId, orderId: order.id, upsellRuleId: match.rule.id, offerId, orderItemId: made.item ? made.item.id : null, amount: made.order.totalAmount },
          { transaction }
        );
        await recordAudit({
          workspaceId,
          actorUserId: null,
          action: 'order.upsell_accepted',
          entityType: 'Order',
          entityId: order.id,
          after: { offerId, upsellRuleId: match.rule.id, followOnOrderId: made.order.id },
          transaction,
        });
        charge = made.chargeWith ? { orderId: made.order.id, savedMethodId: made.chargeWith } : null;
        return {
          id: made.order.id,
          orderNumber: made.order.orderNumber,
          subtotalAmount: Number(made.order.subtotalAmount),
          shippingAmount: Number(made.order.shippingAmount),
          totalAmount: Number(made.order.totalAmount),
          currency: made.order.currency,
          followOn: true,
          paymentMethod: made.order.paymentMethod,
          added: { name: match.card.name, productName: match.card.productName, amount: Number(made.item ? made.item.lineTotalAmount : made.order.totalAmount) },
        };
      }

      const { item } = await orderService.addLineToOpenOrder(
        workspaceId,
        order,
        line,
        { isUpsell: true },
        transaction
      );
      await db.UpsellAcceptance.create(
        { workspaceId, orderId: order.id, upsellRuleId: match.rule.id, offerId, orderItemId: item.id, amount: item.lineTotalAmount },
        { transaction }
      );
      await recordAudit({
        workspaceId,
        actorUserId: null,
        action: 'order.upsell_accepted',
        entityType: 'Order',
        entityId: order.id,
        after: { offerId, upsellRuleId: match.rule.id, totalAmount: Number(order.totalAmount) },
        transaction,
      });
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        subtotalAmount: Number(order.subtotalAmount),
        shippingAmount: Number(order.shippingAmount),
        totalAmount: Number(order.totalAmount),
        currency: order.currency,
        added: { name: match.card.name, productName: match.card.productName, amount: Number(item.lineTotalAmount) },
      };
    });
    // A linked order to a saved card: charged now, outside the transaction.
    if (charge) result.payment = await followOns.chargeFollowOn(workspaceId, charge.orderId, charge.savedMethodId);
    else if (result.followOn) result.payment = { status: 'cod' };
    return result;
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw new AppError('UPSELL_CLOSED', 'This order can no longer be added to', 409);
    if (err && err.code === 'INSUFFICIENT_STOCK') throw new AppError('UPSELL_CLOSED', 'This offer just sold out', 409);
    throw err;
  }
}

// ------------------------------------------------------------ exit downsell --

function readExitDownsell(settings) {
  const stored = settings && typeof settings === 'object' ? settings[EXIT_KEY] : null;
  const { value, error } = schemas.exitDownsell.validate(stored || { enabled: false }, { stripUnknown: true });
  return error ? schemas.exitDownsell.validate({ enabled: false }).value : value;
}

async function getExitDownsell(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return readExitDownsell(workspace.settings);
}

async function saveExitDownsell(workspaceId, body, req) {
  const data = blankToNull(body, ['title', 'message']);
  if (data.discountId) {
    const discount = await db.Discount.findOne({ where: { id: data.discountId, workspaceId } });
    if (!discount || !discount.code) {
      throw new ValidationError([{ field: 'discountId', message: 'Choose a discount that has a code' }]);
    }
  }
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = readExitDownsell(workspace.settings);
    workspace.settings = { ...(workspace.settings || {}), [EXIT_KEY]: data };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'exit_downsell.update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before,
      after: data,
      req,
      transaction,
    });
    return data;
  });
}

/** What the storefront needs to show the popup, or null (off, or its coupon is no longer usable). */
async function publicExitDownsell(workspace) {
  const config = readExitDownsell(workspace.settings);
  if (!config.enabled) return null;
  let code = null;
  if (config.discountId) {
    const now = new Date();
    const discount = await db.Discount.findOne({ where: { id: config.discountId, workspaceId: workspace.id, status: 'active' } });
    const live =
      discount &&
      discount.code &&
      (!discount.startsAt || discount.startsAt <= now) &&
      (!discount.endsAt || discount.endsAt > now) &&
      (discount.usageLimit === null || discount.usageCount < discount.usageLimit);
    // A popup promising a coupon that will be refused is worse than no popup.
    if (!live) return null;
    code = discount.code;
  }
  return {
    trigger: config.trigger,
    delaySeconds: config.delaySeconds,
    title: config.title || null,
    message: config.message || null,
    code,
    pages: config.pages,
  };
}

module.exports = {
  MAX_BUMPS,
  PLACEMENTS,
  schemas,
  listBumps,
  saveBump,
  deleteBump: (workspaceId, id, req) => deleteRule(db.OrderBump, 'OrderBump', 'order_bump.delete', workspaceId, id, req),
  publicBumpsForProduct,
  resolveBumpItems,
  listCrossSell,
  saveCrossSell,
  deleteCrossSell: (workspaceId, id, req) => deleteRule(db.CrossSellRule, 'CrossSellRule', 'cross_sell.delete', workspaceId, id, req),
  suggestCrossSell,
  listUpsells,
  saveUpsell,
  deleteUpsell: (workspaceId, id, req) => deleteRule(db.UpsellRule, 'UpsellRule', 'upsell_rule.delete', workspaceId, id, req),
  publicUpsell,
  acceptUpsell,
  getExitDownsell,
  saveExitDownsell,
  publicExitDownsell,
};
