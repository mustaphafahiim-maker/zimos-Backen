'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');

/*
 * Customer privacy requests (spec-gaps item 235).
 *
 * - A signed-in shopper downloads a copy of their data at once (JSON:
 *   profile, addresses, orders with lines, points and store credit with
 *   their history, wishlist); the request is logged as completed.
 * - A signed-in shopper asks to be erased: a pending request the team
 *   completes (or declines with a note). The team can also erase a
 *   customer from the dashboard directly.
 * - Erase removes personal details and keeps the business record: the
 *   customer becomes "Deleted customer" with no phone, email, company or
 *   addresses; their orders keep amounts, lines and the governorate/city
 *   (for accounts and tax) but lose name, phone, email and street address;
 *   saved cards, sign-in codes and wishlist are deleted; review author
 *   names are hidden; the shopper is signed out everywhere. It is refused
 *   while an order is still on its way (unless the team forces it).
 */

const ERASED_NAME = 'Deleted customer';
const OPEN_STAGES = ['pending_confirmation', 'needs_follow_up', 'awaiting_payment', 'ready_to_ship', 'shipped', 'out_for_delivery'];

async function exportOf(customer) {
  const orders = await db.Order.findAll({
    where: { customerId: customer.id },
    include: [{ model: db.OrderItem, as: 'items', attributes: ['productNameSnapshot', 'variantOptionsSnapshot', 'quantity', 'unitPriceAmount', 'lineTotalAmount'] }],
    order: [['createdAt', 'DESC']],
  });
  const addresses = await db.CustomerAddress.findAll({ where: { customerId: customer.id } }).catch(() => []);
  const wishlist = await db.sequelize.query('SELECT p.name, w.created_at AS "addedAt" FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.customer_id = :c', { replacements: { c: customer.id }, type: QueryTypes.SELECT });
  const loyalty = await db.LoyaltyTransaction.findAll({ where: { customerId: customer.id }, attributes: ['kind', 'points', 'balanceAfter', 'createdAt'], order: [['createdAt', 'ASC']] });
  const credit = await db.StoreCreditTransaction.findAll({ where: { customerId: customer.id }, attributes: ['kind', 'amount', 'balanceAfter', 'currency', 'createdAt'], order: [['createdAt', 'ASC']] });
  return {
    exportedAt: new Date().toISOString(),
    profile: { fullName: customer.fullName, phone: customer.phoneRaw || customer.phoneNormalized, alternatePhone: customer.alternatePhone, email: customer.email, companyName: customer.companyName, taxId: customer.taxId, marketingConsent: customer.marketingConsent, createdAt: customer.createdAt },
    addresses: addresses.map((a) => { const x = a.toJSON(); delete x.workspaceId; delete x.customerId; return x; }),
    savedAddresses: customer.savedAddresses || [],
    orders: orders.map((o) => ({ orderNumber: o.orderNumber, createdAt: o.createdAt, totalAmount: String(o.totalAmount), currency: o.currency, paymentMethod: o.paymentMethod, contact: o.contactSnapshot, shippingAddress: o.shippingAddressSnapshot, items: o.items.map((i) => ({ name: i.productNameSnapshot, options: i.variantOptionsSnapshot, quantity: i.quantity, unitPrice: String(i.unitPriceAmount), total: String(i.lineTotalAmount) })) })),
    loyalty: { balance: customer.loyaltyPoints, history: loyalty.map((t) => t.toJSON()) },
    storeCredit: { balance: String(customer.storeCreditAmount), history: credit.map((t) => ({ ...t.toJSON(), amount: String(t.amount), balanceAfter: String(t.balanceAfter) })) },
    wishlist,
  };
}

async function openOrders(customerId) {
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS n FROM (SELECT ${STAGE_SQL} AS stage FROM ${ORDERS_WITH_STAGE_FROM} WHERE o.customer_id = :c AND o.cancelled_at IS NULL) x WHERE x.stage IN (:stages)`,
    { replacements: { c: customerId, stages: OPEN_STAGES }, type: QueryTypes.SELECT }
  );
  return row.n;
}

async function erase(customer, { force = false, req, transaction }) {
  if (!force && (await openOrders(customer.id))) throw new AppError('CUSTOMER_HAS_OPEN_ORDERS', 'This customer has orders still on their way; erase after they are delivered, or force it', 409);
  const id = customer.id;
  // Read before they are wiped: what the customer was known by, to find copies kept elsewhere (item 286).
  const { normalizePhone } = require('../../core/utils/phone');
  // As stored (normalized) and as typed: forms and quotes keep the number the way it was typed.
  const phones = [...new Set([customer.phoneNormalized, customer.phoneRaw, customer.alternatePhone, normalizePhone(customer.phoneRaw || ''), normalizePhone(customer.alternatePhone || '')].filter((p) => p && !String(p).startsWith('x')).map(String))];
  const email = customer.email ? String(customer.email).trim().toLowerCase() : null;
  await customer.update({
    fullName: ERASED_NAME, email: null, phoneRaw: null, alternatePhone: null,
    phoneNormalized: `x${id.replace(/-/g, '').slice(0, 24)}`,
    companyName: null, taxId: null, taxExemptNote: null, savedAddresses: [], marketingConsent: false,
    accountVersion: (customer.accountVersion || 1) + 1,
  }, { transaction, hooks: false });
  const keepPlace = `jsonb_strip_nulls(jsonb_build_object('country', shipping_address_snapshot->'country', 'province', shipping_address_snapshot->'province', 'city', shipping_address_snapshot->'city'))`;
  await db.sequelize.query(
    `UPDATE orders SET contact_snapshot = jsonb_build_object('fullName', :name), shipping_address_snapshot = CASE WHEN shipping_address_snapshot IS NULL THEN NULL ELSE ${keepPlace} END,
       billing_address_snapshot = CASE WHEN billing_address_snapshot IS NULL THEN NULL ELSE ${keepPlace.replace(/shipping_address_snapshot/g, 'billing_address_snapshot')} END WHERE customer_id = :c`,
    { replacements: { c: id, name: ERASED_NAME }, transaction }
  );
  await db.sequelize.query('DELETE FROM customer_addresses WHERE customer_id = :c', { replacements: { c: id }, transaction });
  await db.sequelize.query('DELETE FROM shopper_login_codes WHERE customer_id = :c', { replacements: { c: id }, transaction });
  // Copies kept by phone or email rather than by customer (item 286). '' never matches a real value.
  const r = { c: id, ws: customer.workspaceId, phones: phones.length ? phones : [''], email: email || '', name: ERASED_NAME };
  const q = (sql) => db.sequelize.query(sql, { replacements: r, transaction });
  // Sign-in codes asked for before the account existed (or for an unknown number) carry only the target.
  await q('DELETE FROM shopper_login_codes WHERE workspace_id = :ws AND (target IN (:phones) OR target = :email)');
  // Checkout verification codes: short-lived, kept by phone only.
  await q('DELETE FROM otp_codes WHERE phone IN (:phones)');
  // Abandoned and converted checkouts: the cart stays for the store's figures, the person goes.
  await q("UPDATE checkout_sessions SET contact_fields = '{}'::jsonb, phone_normalized = NULL, checkout_payload = NULL, ip_address = NULL WHERE workspace_id = :ws AND (phone_normalized IN (:phones) OR converted_order_id IN (SELECT id FROM orders WHERE customer_id = :c))");
  await q('DELETE FROM form_submissions WHERE workspace_id = :ws AND (customer_id = :c OR phone IN (:phones) OR lower(email) = :email)');
  await q("UPDATE quote_requests SET contact = jsonb_build_object('fullName', :name::text) WHERE workspace_id = :ws AND (customer_id = :c OR contact->>'phone' IN (:phones) OR lower(contact->>'email') = :email)");
  await q('UPDATE product_questions SET asker_name = NULL, asker_email = NULL WHERE workspace_id = :ws AND lower(asker_email) = :email');
  await q('UPDATE shipment_batch_items SET carrier_address = NULL WHERE order_id IN (SELECT id FROM orders WHERE customer_id = :c)');
  // WhatsApp inbox: the thread stays (the team's replies are the store's), without the person or their words.
  await q("UPDATE whatsapp_messages SET body = NULL WHERE conversation_id IN (SELECT id FROM whatsapp_conversations WHERE workspace_id = :ws AND (customer_id = :c OR phone_normalized IN (:phones)))");
  await q("UPDATE whatsapp_conversations SET customer_name = NULL, last_message_preview = NULL, phone_normalized = 'x' || left(replace(id::text, '-', ''), 24) WHERE workspace_id = :ws AND (customer_id = :c OR phone_normalized IN (:phones))");
  await db.sequelize.query('DELETE FROM payment_methods_saved WHERE customer_id = :c', { replacements: { c: id }, transaction });
  await db.sequelize.query('DELETE FROM wishlist_items WHERE customer_id = :c', { replacements: { c: id }, transaction });
  await db.sequelize.query('UPDATE reviews SET author_name = NULL WHERE customer_id = :c', { replacements: { c: id }, transaction });
  // The email lists the store syncs to drop the old address (item 308): an internal event only — not a
  // webhook topic — since it carries the address that was just erased here.
  if (email) await require('../../core/outbox/outbox').record(transaction, 'contact.erased', { workspaceId: customer.workspaceId, customerId: id, formerEmail: email });
  await recordAudit({ workspaceId: customer.workspaceId, actorUserId: req && req.user ? req.user.id : null, action: 'customer.erase', entityType: 'Customer', entityId: id, after: { force }, req, transaction });
}

const view = (r) => ({ id: r.id, customerId: r.customerId, kind: r.kind, status: r.status, requesterLabel: r.requesterLabel, reason: r.reason, decisionNote: r.decisionNote, completedAt: r.completedAt, createdAt: r.createdAt });
// "Mona A. · …4567": enough for the team to recognise the request after the erase.
function labelOf(c) {
  const name = String(c.fullName || '').trim().split(/\s+/);
  const short = name.length > 1 ? `${name[0]} ${name[1][0]}.` : name[0] || '';
  const phone = String(c.phoneRaw || c.phoneNormalized || '');
  return `${short}${phone ? ` · …${phone.slice(-4)}` : ''}`.slice(0, 120);
}

// ----------------------------------------------------------------- staff --

// Mounted at /api/v1/workspaces/:workspaceId/privacy-requests.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const reqP = Joi.object({ ...ws, requestId: Joi.string().uuid().required() });

staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('pending', 'completed', 'declined'), kind: Joi.string().valid('export', 'erase') }) }), asyncHandler(async (req, res) => {
  const where = { workspaceId: req.tenant.workspaceId };
  if (req.query.status) where.status = req.query.status;
  if (req.query.kind) where.kind = req.query.kind;
  const rows = await db.PrivacyRequest.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
  res.json({ requests: rows.map(view), pending: await db.PrivacyRequest.count({ where: { workspaceId: req.tenant.workspaceId, status: 'pending' } }) });
}));
staff.post('/:requestId/complete', requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), validate({ params: reqP, body: Joi.object({ force: Joi.boolean().default(false), note: Joi.string().trim().max(500).allow('', null) }) }), asyncHandler(async (req, res) => {
  const r = await db.PrivacyRequest.findOne({ where: { id: req.params.requestId, workspaceId: req.tenant.workspaceId } });
  if (!r) throw new NotFoundError('Request');
  if (r.status !== 'pending' || r.kind !== 'erase') throw new AppError('REQUEST_NOT_PENDING', 'Only a pending erase request can be completed', 409);
  await db.sequelize.transaction(async (transaction) => {
    const c = r.customerId ? await db.Customer.findOne({ where: { id: r.customerId, workspaceId: r.workspaceId }, transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (c) await erase(c, { force: req.body.force, req, transaction });
    await r.update({ status: 'completed', completedAt: new Date(), completedBy: req.user.id, decisionNote: req.body.note || null }, { transaction });
  });
  res.json({ request: view(r) });
}));
staff.post('/:requestId/decline', requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), validate({ params: reqP, body: Joi.object({ note: Joi.string().trim().min(1).max(500).required() }) }), asyncHandler(async (req, res) => {
  const r = await db.PrivacyRequest.findOne({ where: { id: req.params.requestId, workspaceId: req.tenant.workspaceId } });
  if (!r) throw new NotFoundError('Request');
  if (r.status !== 'pending') throw new AppError('REQUEST_NOT_PENDING', 'This request is not pending', 409);
  await r.update({ status: 'declined', completedAt: new Date(), completedBy: req.user.id, decisionNote: req.body.note });
  await recordAudit({ workspaceId: r.workspaceId, actorUserId: req.user.id, action: 'privacy_request.decline', entityType: 'PrivacyRequest', entityId: r.id, after: { note: req.body.note }, req });
  res.json({ request: view(r) });
}));
// The team: a copy of a customer's data, or erase them now (e.g. asked by phone).
const custP = Joi.object({ ...ws, customerId: Joi.string().uuid().required() });
staff.get('/customers/:customerId/export', requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), validate({ params: custP }), asyncHandler(async (req, res) => {
  const c = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId } });
  if (!c) throw new NotFoundError('Customer');
  await recordAudit({ workspaceId: c.workspaceId, actorUserId: req.user.id, action: 'customer.data_export', entityType: 'Customer', entityId: c.id, req });
  res.set('Cache-Control', 'private, no-store');
  res.json(await exportOf(c));
}));
staff.post('/customers/:customerId/erase', requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), validate({ params: custP, body: Joi.object({ force: Joi.boolean().default(false), note: Joi.string().trim().max(500).allow('', null) }) }), asyncHandler(async (req, res) => {
  await db.sequelize.transaction(async (transaction) => {
    const c = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!c) throw new NotFoundError('Customer');
    const label = labelOf(c);
    await erase(c, { force: req.body.force, req, transaction });
    await db.PrivacyRequest.create({ workspaceId: c.workspaceId, customerId: c.id, kind: 'erase', status: 'completed', requesterLabel: label, decisionNote: req.body.note || 'Erased by the team', completedAt: new Date(), completedBy: req.user.id }, { transaction });
  });
  res.json({ erased: true });
}));

// ------------------------------------------------------------- storefront --

// Mounted at /api/v1/store/:workspaceId/account/privacy (X-Shopper-Token).
const account = Router({ mergeParams: true });
account.use(resolvePublicWorkspace);
async function shopperOf(req) {
  const c = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!c) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  return c;
}
account.get('/export', asyncHandler(async (req, res) => {
  const c = await shopperOf(req);
  await db.PrivacyRequest.create({ workspaceId: c.workspaceId, customerId: c.id, kind: 'export', status: 'completed', requesterLabel: labelOf(c), completedAt: new Date() });
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(await exportOf(c));
}));
account.post('/erase', validate({ body: Joi.object({ reason: Joi.string().trim().max(500).allow('', null) }) }), asyncHandler(async (req, res) => {
  const c = await shopperOf(req);
  const existing = await db.PrivacyRequest.findOne({ where: { customerId: c.id, kind: 'erase', status: 'pending' } });
  if (existing) return res.json({ request: view(existing) });
  const r = await db.PrivacyRequest.create({ workspaceId: c.workspaceId, customerId: c.id, kind: 'erase', status: 'pending', requesterLabel: labelOf(c), reason: req.body.reason || null });
  return res.status(201).json({ request: view(r) });
}));
account.get('/', asyncHandler(async (req, res) => {
  const c = await shopperOf(req);
  const rows = await db.PrivacyRequest.findAll({ where: { customerId: c.id }, order: [['createdAt', 'DESC']], limit: 20 });
  res.set('Cache-Control', 'private, no-store');
  res.json({ requests: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, decisionNote: r.decisionNote, createdAt: r.createdAt, completedAt: r.completedAt })) });
}));

module.exports = { staff, account, exportOf, erase };
