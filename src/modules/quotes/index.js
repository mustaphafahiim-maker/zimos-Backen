'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { trackingLimiter } = require('../../core/middleware/rateLimiters');
const { clientIp } = require('../../core/middleware/clientIp');

/*
 * B2B quote requests (spec-gaps item 219).
 *
 *   shopper  asks for quantities (any visitor, or a signed-in shopper) and gets
 *            a private token for the quote (shown once; only its hash is kept)
 *   staff    answer with a unit price per line and a validity date → quoted
 *   shopper  accepts (with a shipping address) → an order at exactly the
 *            quoted prices (the server-pinned price marker), cash on delivery;
 *            the team can then send a payment link from the order. Or declines.
 * A quote past its date can't be accepted. Every price is the merchant's.
 * The team gets a `quote.request` notification; the shopper's email (if any)
 * hears once when the quote is ready.
 */

const PINNED = Symbol.for('zimos.productTestPrice');
const EXACT_PRICES = Symbol.for('zimos.exactPrices');
const OPEN = ['new', 'quoted'];
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const MAX_PER_IP_HOUR = 5;

async function nextNumber(workspaceId, transaction) {
  // One number at a time per store (item 275): two requests at once would both read the same MAX.
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `quote-number:${workspaceId}` }, transaction });
  const [row] = await db.sequelize.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM quote_requests WHERE workspace_id = :ws", { replacements: { ws: workspaceId }, type: db.Sequelize.QueryTypes.SELECT, transaction });
  return `Q-${String(row.n).padStart(4, '0')}`;
}

async function linesView(workspaceId, lines, quoted) {
  const ids = [...new Set((lines || []).map((l) => l.variantId))];
  const variants = new Map((ids.length ? await db.ProductVariant.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'sku', 'optionValues', 'priceAmount', 'currency'], include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }] }) : []).map((v) => [v.id, v]));
  const q = new Map((quoted || []).map((l) => [l.variantId, l]));
  return (lines || []).map((l) => {
    const v = variants.get(l.variantId);
    const offer = q.get(l.variantId);
    return { variantId: l.variantId, productName: v && v.product ? v.product.name : null, sku: v ? v.sku : null, optionValues: v ? v.optionValues : null, quantity: offer ? offer.quantity : l.quantity, requestedQuantity: l.quantity, note: l.note || null, listPrice: v ? String(v.priceAmount) : null, unitPrice: offer ? String(offer.unitPrice) : null, lineTotal: offer ? String(offer.unitPrice * offer.quantity) : null };
  });
}

function stateOf(q) {
  if (q.status === 'quoted' && q.validUntil && new Date(q.validUntil) < new Date()) return 'expired';
  return q.status;
}

async function view(q, { staff = false } = {}) {
  const lines = await linesView(q.workspaceId, q.lines, q.quotedLines);
  const total = q.quotedLines ? q.quotedLines.reduce((n, l) => n + l.unitPrice * l.quantity, 0) : null;
  return {
    id: q.id, number: q.number, status: stateOf(q), contact: staff ? q.contact : { fullName: q.contact.fullName, company: q.contact.company || null },
    lines, message: q.message, quotedNote: q.quotedNote, totalAmount: total === null ? null : String(total), currency: q.currency, validUntil: q.validUntil, quotedAt: q.quotedAt, orderId: q.orderId, createdAt: q.createdAt,
    ...(staff ? { customerId: q.customerId } : {}),
  };
}

async function findByToken(workspaceId, id, token) {
  const q = await db.QuoteRequest.findOne({ where: { id, workspaceId } });
  if (!q || !token || q.tokenHash !== hash(token)) throw new NotFoundError('Quote');
  return q;
}

// ---------------------------------------------------------------- shopper --

async function request(workspace, body, req) {
  const ids = [...new Set(body.lines.map((l) => l.variantId))];
  if ((await db.ProductVariant.count({ where: { id: ids, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', where: { status: 'active' }, attributes: [] }] })) !== ids.length) {
    throw new ValidationError([{ field: 'lines', message: 'A product is not available' }]);
  }
  const ip = clientIp(req);
  if (ip && (await db.QuoteRequest.count({ where: { requestIp: ip, createdAt: { [Op.gt]: new Date(Date.now() - 3600e3) } } })) >= MAX_PER_IP_HOUR) {
    throw new AppError('TOO_MANY_REQUESTS', 'Too many quote requests — try again later', 429);
  }
  const shopper = req.headers['x-shopper-token'] ? await require('../shopperAccounts/shopperAuth').readToken(workspace.id, req.headers['x-shopper-token']) : null;
  const token = crypto.randomBytes(24).toString('base64url');
  const q = await db.sequelize.transaction(async (transaction) => db.QuoteRequest.create({
    workspaceId: workspace.id, number: await nextNumber(workspace.id, transaction), customerId: shopper ? shopper.id : null,
    contact: { fullName: body.contact.fullName, phone: body.contact.phone, email: body.contact.email ? body.contact.email.toLowerCase() : null, company: body.contact.company || null },
    lines: body.lines, message: body.message || null, tokenHash: hash(token), requestIp: ip || null,
  }, { transaction }));
  await require('../notifications/merchantNotificationService').create(workspace.id, {
    type: 'quote.request', title: `طلب عرض سعر ${q.number}`, body: `${body.contact.fullName}${body.contact.company ? ` — ${body.contact.company}` : ''}: ${body.lines.length} منتج`, link: `/quotes/${q.id}`,
    data: { quoteId: q.id, number: q.number }, dedupeKey: `quote:${q.id}`,
    localized: { en: { title: `Quote request ${q.number}`, body: `${body.contact.fullName}: ${body.lines.length} products` }, ar: { title: `طلب عرض سعر ${q.number}`, body: `${body.contact.fullName}: ${body.lines.length} منتج` } },
  });
  return { quoteId: q.id, number: q.number, token, status: 'new' };
}

async function accept(workspace, id, { token, shippingAddress, notes }, req) {
  await findByToken(workspace.id, id, token);
  // The quote is locked while its order is made, in the order's own transaction (item 275):
  // a double click or a retry waits, then finds it accepted — one order, never two.
  const { q, order } = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.QuoteRequest.findOne({ where: { id, workspaceId: workspace.id }, lock: transaction.LOCK.UPDATE, transaction });
    const state = stateOf(locked);
    if (state === 'expired') throw new AppError('QUOTE_EXPIRED', 'This quote has expired — ask for a new one', 409);
    if (state !== 'quoted') throw new AppError('QUOTE_NOT_OPEN', 'This quote cannot be accepted', 409);
    const items = locked.quotedLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, [PINNED]: l.unitPrice }));
    const { order: created } = await require('../orders/orderService').createOrder(workspace.id, {
      contact: { fullName: locked.contact.fullName, phone: locked.contact.phone, email: locked.contact.email || undefined },
      shippingAddress, paymentMethod: 'cod', items, notes: [`Quote ${locked.number}`, notes].filter(Boolean).join(' — ').slice(0, 1000),
      // Exactly the quoted prices: no automatic discount or bundle tier on top.
      [EXACT_PRICES]: true,
    }, req, { transaction });
    await locked.update({ status: 'accepted', orderId: created.id }, { transaction });
    await db.Order.update({ tags: [...new Set([...(created.tags || []), 'quote'])] }, { where: { id: created.id }, hooks: false, transaction });
    return { q: locked, order: created };
  });
  return { quote: await view(q), orderId: order.id, orderNumber: order.orderNumber, totalAmount: String(order.totalAmount) };
}

/** Closes an open quote (declined / cancelled) unless an accept or another close got there first. */
async function close(workspaceId, id, status, code = 'QUOTE_NOT_OPEN') {
  const [n] = await db.QuoteRequest.update({ status }, { where: { id, workspaceId, status: OPEN } });
  if (n !== 1) throw new AppError(code, 'This quote is closed', 409);
  return db.QuoteRequest.findOne({ where: { id, workspaceId } });
}

// ----------------------------------------------------------------- staff --

async function answer(workspaceId, id, body, req) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'defaultCurrency', 'defaultLocale'] });
  // Locked, so an answer can't reopen a quote the shopper is accepting or just closed (item 275).
  const { q, firstQuote } = await db.sequelize.transaction(async (transaction) => {
    const row = await db.QuoteRequest.findOne({ where: { id, workspaceId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!row) throw new NotFoundError('Quote');
    if (!OPEN.includes(row.status)) throw new AppError('QUOTE_CLOSED', 'This quote is closed', 409);
    const requested = new Set(row.lines.map((l) => l.variantId));
    if (body.lines.some((l) => !requested.has(l.variantId))) throw new ValidationError([{ field: 'lines', message: 'Quote only the products that were asked for' }]);
    const first = row.status === 'new';
    await row.update({ status: 'quoted', quotedLines: body.lines, quotedNote: body.note || null, validUntil: body.validUntil, currency: workspace.defaultCurrency || 'EGP', quotedAt: new Date(), quotedBy: req.user.id }, { transaction });
    return { q: row, firstQuote: first };
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'quote.answer', entityType: 'QuoteRequest', entityId: q.id, after: { lines: body.lines.length, validUntil: body.validUntil }, req });
  if (firstQuote && q.contact.email) {
    try {
      const origin = await require('../domains/primaryHost').storeOriginOf(workspace);
      await require('../notifications/notify').email({
        recipient: q.contact.email,
        template: 'merchant_notification',
        workspaceId,
        data: { title: `${workspace.name}: عرض السعر ${q.number} جاهز / Your quote ${q.number} is ready`, body: `${origin}/quotes/${q.id}` },
      });
    } catch (err) {
      logger.warn(`[quotes] email ${q.id}: ${err.message}`);
    }
  }
  return view(q, { staff: true });
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/store/:workspaceId/quotes.
const store = Router({ mergeParams: true });
const sp = { workspaceId: Joi.string().required() };
const qp = Joi.object({ ...sp, quoteId: Joi.string().uuid().required() });
store.post(
  '/',
  trackingLimiter,
  resolvePublicWorkspace,
  validate({ params: Joi.object(sp), body: Joi.object({ contact: Joi.object({ fullName: Joi.string().trim().min(2).max(120).required(), phone: Joi.string().trim().min(6).max(32).required(), email: Joi.string().trim().email().max(255).allow('', null), company: Joi.string().trim().max(120).allow('', null) }).required(), lines: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(100000).required(), note: Joi.string().trim().max(300).allow('', null) })).min(1).max(50).unique('variantId').required(), message: Joi.string().trim().max(2000).allow('', null) }) }),
  asyncHandler(async (req, res) => res.status(201).json(await request(req.publicWorkspace, req.body, req)))
);
store.get('/:quoteId', resolvePublicWorkspace, validate({ params: qp, query: Joi.object({ token: Joi.string().max(100).required() }) }), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ quote: await view(await findByToken(req.publicWorkspace.id, req.params.quoteId, req.query.token)) });
}));
store.post('/:quoteId/accept', resolvePublicWorkspace, validate({ params: qp, body: Joi.object({ token: Joi.string().max(100).required(), shippingAddress: Joi.object({ country: Joi.string().length(2).default('EG'), province: Joi.string().max(120).required(), city: Joi.string().max(120).required(), area: Joi.string().max(120).allow('', null), addressLine: Joi.string().max(500).required(), placeId: Joi.string().uuid() }).required(), notes: Joi.string().trim().max(500).allow('', null) }) }), asyncHandler(async (req, res) => res.status(201).json(await accept(req.publicWorkspace, req.params.quoteId, req.body, req))));
store.post('/:quoteId/decline', resolvePublicWorkspace, validate({ params: qp, body: Joi.object({ token: Joi.string().max(100).required() }) }), asyncHandler(async (req, res) => {
  await findByToken(req.publicWorkspace.id, req.params.quoteId, req.body.token);
  res.json({ quote: await view(await close(req.publicWorkspace.id, req.params.quoteId, 'declined')) });
}));

// Mounted at /api/v1/workspaces/:workspaceId/quotes (orders.view / orders.manage).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, quoteId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('new', 'quoted', 'accepted', 'declined', 'cancelled') }) }), asyncHandler(async (req, res) => {
  const rows = await db.QuoteRequest.findAll({ where: { workspaceId: req.tenant.workspaceId, ...(req.query.status ? { status: req.query.status } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  res.json({ quotes: rows.map((q) => ({ id: q.id, number: q.number, status: stateOf(q), contact: q.contact, lineCount: q.lines.length, validUntil: q.validUntil, orderId: q.orderId, createdAt: q.createdAt })), newCount: rows.filter((q) => q.status === 'new').length });
}));
staff.get('/:quoteId', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: one }), asyncHandler(async (req, res) => {
  const q = await db.QuoteRequest.findOne({ where: { id: req.params.quoteId, workspaceId: req.tenant.workspaceId } });
  if (!q) throw new NotFoundError('Quote');
  res.json({ quote: await view(q, { staff: true }) });
}));
staff.put(
  '/:quoteId/answer',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: one, body: Joi.object({ lines: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(100000).required(), unitPrice: Joi.number().integer().min(0).max(1e12).required() })).min(1).max(50).unique('variantId').required(), note: Joi.string().trim().max(2000).allow('', null), validUntil: Joi.date().iso().greater('now').required() }) }),
  asyncHandler(async (req, res) => res.json({ quote: await answer(req.tenant.workspaceId, req.params.quoteId, req.body, req) }))
);
staff.post('/:quoteId/cancel', requirePermission(PERMISSIONS.ORDERS_MANAGE), validate({ params: one }), asyncHandler(async (req, res) => {
  const q = await db.QuoteRequest.findOne({ where: { id: req.params.quoteId, workspaceId: req.tenant.workspaceId }, attributes: ['id'] });
  if (!q) throw new NotFoundError('Quote');
  res.json({ quote: await view(await close(req.tenant.workspaceId, q.id, 'cancelled', 'QUOTE_CLOSED'), { staff: true }) });
}));

module.exports = { store, staff };
