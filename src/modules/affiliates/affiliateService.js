'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { QueryTypes } = require('sequelize');
const env = require('../../config/env');
const { scoped } = require('../../core/utils/scopedRepository');
const { normalizePhone } = require('../../core/utils/phone');
const { AppError, NotFoundError, AuthenticationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const otpService = require('../otp/otpService');
const commissions = require('./commissionService');

/**
 * Affiliates (SPEC §20.3): the merchant's side (affiliates, commissions,
 * payouts recorded by hand) and the marketer's portal (OTP login by phone,
 * then their links, orders without customer data, balance and payouts).
 */

const OTP_PURPOSE = 'affiliate_portal';
const PORTAL_TTL_MS = 12 * 60 * 60 * 1000;

function cleanCode(code) {
  return String(code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

function view(a, totals) {
  return {
    id: a.id,
    name: a.name,
    phone: a.phoneNormalized,
    code: a.code,
    commissionType: a.commissionType,
    commissionValue: Number(a.commissionValue),
    productIds: a.productIds || [],
    status: a.status,
    notes: a.notes,
    createdAt: a.createdAt,
    ...(totals ? { totals } : {}),
  };
}

const ZERO = { orders: 0, pending: '0', approved: '0', paid: '0', void: '0' };

/** Per affiliate: referred orders and money by commission status. */
async function totalsFor(workspaceId, affiliateIds) {
  if (affiliateIds.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT affiliate_id, status, COUNT(*)::int AS orders, COALESCE(SUM(amount), 0) AS amount
       FROM affiliate_commissions
      WHERE workspace_id = :workspaceId AND affiliate_id IN (:affiliateIds)
      GROUP BY affiliate_id, status`,
    { replacements: { workspaceId, affiliateIds }, type: QueryTypes.SELECT }
  );
  const out = new Map();
  for (const row of rows) {
    const t = out.get(row.affiliate_id) || { ...ZERO };
    t[row.status] = String(row.amount);
    if (row.status !== 'void') t.orders += row.orders;
    out.set(row.affiliate_id, t);
  }
  return out;
}

async function listAffiliates(workspaceId) {
  // Late attributions and returns are picked up when the merchant looks.
  await commissions.reconcile(workspaceId);
  const affiliates = await db.Affiliate.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
  const totals = await totalsFor(workspaceId, affiliates.map((a) => a.id));
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'] });
  return { affiliates: affiliates.map((a) => view(a, totals.get(a.id) || { ...ZERO })), currency: workspace.defaultCurrency };
}

function checkRate(type, value) {
  if (type === 'percent' && (value < 1 || value > 10000)) {
    throw new AppError('VALIDATION_ERROR', 'A percentage is between 0.01% and 100%', 422, [{ field: 'commissionValue', message: 'out of range' }]);
  }
}

async function saveAffiliate(workspaceId, affiliateId, data, req) {
  const existing = affiliateId ? await scoped(db.Affiliate, workspaceId, 'Affiliate').findByPkOrThrow(affiliateId) : null;
  const before = existing ? view(existing) : null;
  const values = {};
  if (data.name !== undefined) values.name = data.name;
  if (data.phone !== undefined) {
    values.phoneNormalized = normalizePhone(data.phone);
    if (!values.phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  }
  if (data.code !== undefined) {
    values.code = cleanCode(data.code);
    if (values.code.length < 2) {
      throw new AppError('VALIDATION_ERROR', 'The code needs at least 2 letters or digits', 422, [{ field: 'code', message: 'too short' }]);
    }
  }
  for (const key of ['commissionType', 'commissionValue', 'productIds', 'status', 'notes']) {
    if (data[key] !== undefined) values[key] = data[key];
  }
  checkRate(values.commissionType || (existing && existing.commissionType), Number(values.commissionValue ?? (existing && existing.commissionValue)));
  if (values.productIds && values.productIds.length) {
    const found = await db.Product.count({ where: { workspaceId, id: values.productIds } });
    if (found !== new Set(values.productIds).size) throw new NotFoundError('Product');
  }

  let saved;
  try {
    saved = existing ? await existing.update(values) : await db.Affiliate.create({ ...values, workspaceId });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      const onPhone = /phone/.test(`${err.message} ${(err.parent && err.parent.constraint) || ''}`);
      throw new AppError(
        onPhone ? 'AFFILIATE_PHONE_TAKEN' : 'AFFILIATE_CODE_TAKEN',
        onPhone ? 'Another affiliate already uses that phone number' : 'Another affiliate already uses that code',
        409
      );
    }
    throw err;
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: existing ? 'affiliate.update' : 'affiliate.create',
    entityType: 'Affiliate',
    entityId: saved.id,
    before,
    after: view(saved),
    req,
  });
  return view(saved);
}

async function deleteAffiliate(workspaceId, affiliateId, req) {
  const affiliate = await scoped(db.Affiliate, workspaceId, 'Affiliate').findByPkOrThrow(affiliateId);
  const earned = await db.AffiliateCommission.count({ where: { affiliateId } });
  if (earned > 0) {
    throw new AppError('AFFILIATE_HAS_COMMISSIONS', 'This affiliate has commissions. Pause them instead of deleting.', 409);
  }
  await affiliate.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'affiliate.delete', entityType: 'Affiliate', entityId: affiliateId, before: view(affiliate), req });
}

function commissionView(row, { withOrderLink }) {
  return {
    id: row.id,
    affiliateId: row.affiliate_id,
    affiliateName: row.affiliate_name,
    orderNumber: row.order_number,
    ...(withOrderLink ? { orderId: row.order_id } : {}),
    orderTotal: String(row.total_amount),
    baseAmount: String(row.base_amount),
    amount: String(row.amount),
    currency: row.currency,
    status: row.status,
    orderedAt: row.ordered_at,
    approvedAt: row.approved_at,
    paidAt: row.paid_at,
  };
}

async function commissionRows(workspaceId, { affiliateId, status, limit = 100 }) {
  const where = ['c.workspace_id = :workspaceId'];
  const replacements = { workspaceId, limit };
  if (affiliateId) {
    where.push('c.affiliate_id = :affiliateId');
    replacements.affiliateId = affiliateId;
  }
  if (status) {
    where.push('c.status = :status');
    replacements.status = status;
  }
  return db.sequelize.query(
    `SELECT c.*, a.name AS affiliate_name, o.order_number, o.total_amount, o.created_at AS ordered_at
       FROM affiliate_commissions c
       JOIN affiliates a ON a.id = c.affiliate_id
       JOIN orders o ON o.id = c.order_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );
}

async function listCommissions(workspaceId, params = {}) {
  const rows = await commissionRows(workspaceId, params);
  return { commissions: rows.map((r) => commissionView(r, { withOrderLink: true })) };
}

async function listPayouts(workspaceId, affiliateId) {
  const where = { workspaceId };
  if (affiliateId) where.affiliateId = affiliateId;
  const payouts = await db.AffiliatePayout.findAll({ where, order: [['paidAt', 'DESC']], limit: 200 });
  return payouts.map((p) => ({
    id: p.id,
    affiliateId: p.affiliateId,
    amount: String(p.amount),
    currency: p.currency,
    method: p.method,
    note: p.note,
    paidAt: p.paidAt,
  }));
}

/**
 * The merchant paid an affiliate (Vodafone Cash, transfer…): every approved
 * commission of theirs becomes `paid` under one payout row.
 */
async function recordPayout(workspaceId, affiliateId, { method, note }, req) {
  const affiliate = await scoped(db.Affiliate, workspaceId, 'Affiliate').findByPkOrThrow(affiliateId);
  await commissions.reconcile(workspaceId);
  return db.sequelize.transaction(async (transaction) => {
    const due = await db.AffiliateCommission.findAll({
      where: { workspaceId, affiliateId, status: 'approved' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (due.length === 0) throw new AppError('NOTHING_TO_PAY', 'This affiliate has no approved commission to pay', 409);
    const currencies = new Set(due.map((c) => c.currency));
    if (currencies.size > 1) throw new AppError('MIXED_CURRENCIES', 'The approved commissions are in more than one currency', 409);
    const amount = due.reduce((sum, c) => sum + Number(c.amount), 0);
    const now = new Date();
    const payout = await db.AffiliatePayout.create(
      { workspaceId, affiliateId, amount, currency: due[0].currency, method: method || null, note: note || null, paidAt: now, createdByUserId: req.user.id },
      { transaction }
    );
    await db.AffiliateCommission.update(
      { status: 'paid', paidAt: now, payoutId: payout.id },
      { where: { id: due.map((c) => c.id) }, transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'affiliate.payout',
      entityType: 'AffiliatePayout',
      entityId: payout.id,
      after: { affiliateId: affiliate.id, amount, commissions: due.length, method: method || null },
      req,
      transaction,
    });
    return { id: payout.id, amount: String(amount), currency: payout.currency, commissions: due.length, paidAt: now };
  });
}

// ------------------------------------------------------------------ portal --

function portalKey() {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:affiliate-portal').digest();
}

function signPortalToken(affiliateId, now = Date.now()) {
  const expires = now + PORTAL_TTL_MS;
  const body = `${affiliateId}.${expires}`;
  return `${body}.${crypto.createHmac('sha256', portalKey()).update(body).digest('hex')}`;
}

function readPortalToken(token, now = Date.now()) {
  const [affiliateId, expires, signature] = String(token || '').split('.');
  if (!affiliateId || !expires || !/^[0-9a-f]{64}$/.test(signature || '')) return null;
  const expected = crypto.createHmac('sha256', portalKey()).update(`${affiliateId}.${expires}`).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null;
  return Number(expires) > now ? affiliateId : null;
}

/** Step 1: a code by SMS. The answer is the same whether or not the phone is an affiliate. */
async function portalRequestCode(workspaceId, phone) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  const affiliate = await db.Affiliate.findOne({ where: { workspaceId, phoneNormalized, status: 'active' }, attributes: ['id'] });
  if (affiliate) await otpService.generateAndSendOtp(phoneNormalized, OTP_PURPOSE);
  return { sent: true };
}

/** Step 2: the code for a portal token. */
async function portalVerify(workspaceId, phone, code) {
  const phoneNormalized = normalizePhone(phone);
  const affiliate = phoneNormalized ? await db.Affiliate.findOne({ where: { workspaceId, phoneNormalized, status: 'active' } }) : null;
  if (!affiliate) throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  await otpService.verifyOtp(phoneNormalized, OTP_PURPOSE, code);
  return { token: signPortalToken(affiliate.id), expiresInSeconds: PORTAL_TTL_MS / 1000 };
}

/** Everything the portal shows. Orders carry no customer data — a number, a date and money only. */
async function portalOverview(workspaceId, token) {
  const affiliateId = readPortalToken(token);
  const affiliate = affiliateId ? await db.Affiliate.findOne({ where: { id: affiliateId, workspaceId, status: 'active' } }) : null;
  if (!affiliate) throw new AuthenticationError('Sign in again', 'AFFILIATE_SESSION_EXPIRED');

  await commissions.reconcile(workspaceId);
  const [totals, rows, payouts, products] = await Promise.all([
    totalsFor(workspaceId, [affiliate.id]),
    commissionRows(workspaceId, { affiliateId: affiliate.id, limit: 100 }),
    listPayouts(workspaceId, affiliate.id),
    db.Product.findAll({
      where: { workspaceId, status: 'active', ...(affiliate.productIds.length ? { id: affiliate.productIds } : {}) },
      attributes: ['id', 'name', 'slug'],
      order: [['createdAt', 'DESC']],
      limit: 50,
    }),
  ]);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'name'] });
  return {
    affiliate: {
      name: affiliate.name,
      code: affiliate.code,
      commissionType: affiliate.commissionType,
      commissionValue: Number(affiliate.commissionValue),
    },
    storeName: workspace.name,
    currency: workspace.defaultCurrency,
    totals: totals.get(affiliate.id) || { ...ZERO },
    // The storefront builds the links: /products/<slug>?ref=<code>.
    products: products.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    orders: rows.map((r) => ({
      orderNumber: r.order_number,
      orderedAt: r.ordered_at,
      amount: String(r.amount),
      currency: r.currency,
      status: r.status,
    })),
    payouts: payouts.map(({ affiliateId: _a, ...p }) => p),
  };
}

module.exports = {
  cleanCode,
  listAffiliates,
  saveAffiliate,
  deleteAffiliate,
  listCommissions,
  listPayouts,
  recordPayout,
  portalRequestCode,
  portalVerify,
  portalOverview,
};
