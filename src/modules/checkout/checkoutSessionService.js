'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');

/** A session with no activity for this long, and no order, counts as abandoned. */
const ABANDON_AFTER_MS = 30 * 60 * 1000;

/** Prices the lines from the catalogue (never trusts client prices). */
async function priceItems(workspaceId, items = []) {
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  if (variantIds.length === 0) return { items: [], subtotal: 0, currency: null };
  const variants = await db.ProductVariant.findAll({ where: { workspaceId, id: variantIds } });
  const products = await db.Product.findAll({ where: { workspaceId, id: [...new Set(variants.map((v) => v.productId))] }, attributes: ['id', 'name'] });
  const offerIds = [...new Set(items.map((i) => i.offerId).filter(Boolean))];
  const offers = offerIds.length ? await db.Offer.findAll({ where: { workspaceId, id: offerIds } }) : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const offerById = new Map(offers.map((o) => [o.id, o]));

  const priced = [];
  let subtotal = 0;
  let currency = null;
  for (const item of items) {
    const variant = variantById.get(item.variantId);
    if (!variant) continue;
    const product = productById.get(variant.productId);
    const offer = item.offerId ? offerById.get(item.offerId) : null;
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const lineTotal = offer && offer.pricingMode === 'fixed' ? Number(offer.priceAmount) * quantity : Number(variant.priceAmount) * quantity;
    subtotal += lineTotal;
    currency = currency || variant.currency;
    priced.push({
      productId: variant.productId,
      variantId: variant.id,
      productName: product ? product.name : null,
      options: variant.optionValues || null,
      offerName: offer ? offer.name : null,
      quantity,
      lineTotalAmount: lineTotal,
    });
  }
  return { items: priced, subtotal, currency };
}

/**
 * Public: called by the storefront while the shopper fills the checkout form.
 * Needs a phone or email (otherwise there is nobody to follow up with).
 */
async function upsertSession(workspaceId, body, { cartToken } = {}) {
  const contact = body.contact || {};
  const phoneNormalized = contact.phone ? normalizePhone(contact.phone) : null;
  if (!phoneNormalized && !contact.email) {
    throw new AppError('CONTACT_REQUIRED', 'A phone number or email is needed to save a checkout', 422);
  }

  const { items, subtotal, currency } = await priceItems(workspaceId, body.items);
  let cartId = null;
  if (cartToken) {
    const cart = await db.Cart.findOne({ where: { workspaceId, guestToken: cartToken, status: 'active' }, attributes: ['id'] });
    cartId = cart ? cart.id : null;
  }

  let session = null;
  if (body.sessionId) {
    session = await db.CheckoutSession.findOne({ where: { id: body.sessionId, workspaceId, status: 'in_progress' } });
  }
  if (!session && phoneNormalized) {
    session = await db.CheckoutSession.findOne({
      where: { workspaceId, phoneNormalized, status: 'in_progress', lastActivityAt: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      order: [['lastActivityAt', 'DESC']],
    });
  }

  const fields = {
    workspaceId,
    cartId: cartId || (session ? session.cartId : null),
    phoneNormalized: phoneNormalized || (session ? session.phoneNormalized : null),
    customerName: contact.fullName || (session ? session.customerName : null),
    contactFields: { fullName: contact.fullName || null, phone: contact.phone || null, email: contact.email || null },
    items: items.length ? items : session ? session.items : [],
    subtotalAmount: items.length ? subtotal : session ? session.subtotalAmount : 0,
    currency: currency || (session ? session.currency : 'EGP'),
    source: body.funnelId ? 'funnel' : body.source === 'funnel' ? 'funnel' : 'store',
    attribution: body.funnelId ? { funnelId: body.funnelId } : session ? session.attribution : {},
    visitorId: body.visitorId || (session ? session.visitorId : null),
    lastActivityAt: new Date(),
  };

  if (session) await session.update(fields);
  else session = await db.CheckoutSession.create(fields);
  return { id: session.id, status: session.status };
}

/** After a real order: the shopper's open sessions are converted (recovered if the merchant had reached out). */
async function markConvertedForOrder(workspaceId, { sessionId, phone, orderId }) {
  const phoneNormalized = phone ? normalizePhone(phone) : null;
  const or = [];
  if (sessionId) or.push({ id: sessionId });
  if (phoneNormalized) or.push({ phoneNormalized });
  if (or.length === 0) return 0;
  const sessions = await db.CheckoutSession.findAll({ where: { workspaceId, status: 'in_progress', [Op.or]: or } });
  for (const s of sessions) {
    await s.update({
      status: 'converted',
      convertedOrderId: orderId,
      recoveryStatus: s.recoveryStatus === 'contacted' ? 'recovered' : s.recoveryStatus,
      lastActivityAt: new Date(),
    });
  }
  return sessions.length;
}

function view(s, ordersById) {
  const abandoned = s.status === 'in_progress' && s.lastActivityAt.getTime() < Date.now() - ABANDON_AFTER_MS;
  const contact = s.contactFields || {};
  const order = s.convertedOrderId ? ordersById.get(s.convertedOrderId) : null;
  return {
    id: s.id,
    status: s.status === 'in_progress' ? (abandoned ? 'abandoned' : 'in_progress') : s.status,
    recoveryStatus: s.recoveryStatus,
    customerName: s.customerName || contact.fullName || null,
    phone: contact.phone || null,
    email: contact.email || null,
    items: s.items || [],
    subtotalAmount: Number(s.subtotalAmount),
    currency: s.currency,
    source: s.source,
    lastActivityAt: s.lastActivityAt,
    contactedAt: s.contactedAt,
    createdAt: s.createdAt,
    convertedOrder: order ? { id: order.id, orderNumber: order.orderNumber } : null,
  };
}

/** Staff list. view = abandoned (default) | converted | all. */
async function listSessions(workspaceId, { view: which = 'abandoned', recoveryStatus, limit = 50, before } = {}) {
  const where = { workspaceId };
  if (which === 'abandoned') {
    where.status = 'in_progress';
    where.lastActivityAt = { [Op.lt]: new Date(Date.now() - ABANDON_AFTER_MS) };
  } else if (which === 'converted') {
    where.status = 'converted';
  }
  if (before) where.lastActivityAt = { ...(where.lastActivityAt || {}), [Op.lt]: new Date(Math.min(new Date(before).getTime(), where.lastActivityAt ? where.lastActivityAt[Op.lt].getTime() : Infinity)) };
  if (recoveryStatus) where.recoveryStatus = recoveryStatus;

  const rows = await db.CheckoutSession.findAll({ where, order: [['lastActivityAt', 'DESC']], limit });
  const orderIds = rows.map((r) => r.convertedOrderId).filter(Boolean);
  const orders = orderIds.length ? await db.Order.findAll({ where: { id: orderIds }, attributes: ['id', 'orderNumber'] }) : [];
  const ordersById = new Map(orders.map((o) => [o.id, o]));

  return {
    sessions: rows.map((s) => view(s, ordersById)),
    nextCursor: rows.length === limit ? rows[rows.length - 1].lastActivityAt.toISOString() : null,
  };
}

async function setRecoveryStatus(workspaceId, sessionId, recoveryStatus, req) {
  const session = await db.CheckoutSession.findOne({ where: { id: sessionId, workspaceId } });
  if (!session) throw new NotFoundError('CheckoutSession');
  const before = session.recoveryStatus;
  await session.update({ recoveryStatus, contactedAt: recoveryStatus === 'contacted' ? new Date() : session.contactedAt });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'checkout_session.recovery_status',
    entityType: 'CheckoutSession',
    entityId: session.id,
    before: { recoveryStatus: before },
    after: { recoveryStatus },
    req,
  });
  const orders = session.convertedOrderId ? await db.Order.findAll({ where: { id: session.convertedOrderId }, attributes: ['id', 'orderNumber'] }) : [];
  return view(session, new Map(orders.map((o) => [o.id, o])));
}

module.exports = { upsertSession, markConvertedForOrder, listSessions, setRecoveryStatus, ABANDON_AFTER_MS };
