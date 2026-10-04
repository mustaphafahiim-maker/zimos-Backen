'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const commissions = require('./commissionService');

/**
 * ZIMOS's own referral program for merchants (SPEC §20.4). A merchant joins,
 * gets a code and a sign-up link; a store that subscribes with the code earns
 * them the program's share of every payment it makes to ZIMOS, written to
 * the existing commission ledger (agent_commissions, owned by the merchant).
 * They ask to be paid what is owed; ZIMOS pays by hand and marks it.
 *
 * The share is not in code: platform_settings `merchant_referral_program`
 * { open, rateBp } (basis points), set from the console. Closed, or with no
 * share set, nobody can join (existing codes keep earning at the share they
 * were given, which is stored on the code).
 *
 *   /api/v1/me/referrals                       the merchant (any signed-in account)
 *   /api/v1/admin/referral-program             the console: the setting, and payout requests
 */

const SETTING_KEY = 'merchant_referral_program';
const METHODS = ['vodafone_cash', 'instapay', 'bank_transfer'];

async function program() {
  const row = await db.PlatformSetting.findByPk(SETTING_KEY);
  const value = (row && row.value) || {};
  const rateBp = Number.isInteger(value.rateBp) ? value.rateBp : null;
  return { open: value.open === true && rateBp !== null, rateBp, configured: rateBp !== null };
}

const signupLink = (code) => `${env.frontendUrl.replace(/\/$/, '')}/register?ref=${encodeURIComponent(code)}`;

/** A code from the person's name, unique, in the referral code format. */
async function newCodeFor(user, transaction) {
  const base = String(user.fullName || user.email || 'ZIMOS')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 10) || 'ZIMOS';
  for (let i = 0; i < 5; i += 1) {
    const code = `${base.length >= 3 ? base : `Z${base}ZZ`.slice(0, 3)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    if (!(await db.ReferralCode.findOne({ where: { code }, attributes: ['id'], transaction }))) return code;
  }
  return `Z-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

const ownCode = (userId) => db.ReferralCode.findOne({ where: { agentId: userId, label: 'merchant' }, order: [['createdAt', 'ASC']] });

const payoutView = (r) => ({
  id: r.id,
  amounts: r.amounts,
  method: r.method,
  details: r.details,
  status: r.status,
  note: r.note,
  handledAt: r.handledAt,
  createdAt: r.createdAt,
});

async function overview(user) {
  const [settings, code] = await Promise.all([program(), ownCode(user.id)]);
  if (!code) return { program: settings, code: null };
  const [signups, totals, recent, payouts] = await Promise.all([
    db.Subscription.count({ where: { referralCodeId: code.id } }),
    commissions.totalsFor({ agentId: user.id, codeId: code.id }),
    db.AgentCommission.findAll({ where: { agentId: user.id, codeId: code.id }, order: [['paidAt', 'DESC']], limit: 20 }),
    db.ReferralPayoutRequest.findAll({ where: { userId: user.id }, order: [['createdAt', 'DESC']], limit: 10 }),
  ]);
  return {
    program: settings,
    code: { code: code.code, rateBp: code.commissionRateBp, active: code.active, link: signupLink(code.code), createdAt: code.createdAt },
    signups,
    totals,
    // No store names: what was paid, when, and the share — never who.
    earnings: recent.map((r) => ({
      paidAt: r.paidAt,
      amountPaid: Number(r.amountPaid),
      currency: r.currency,
      commission: Number(r.suggestedCommission),
      status: r.voidedAt ? 'voided' : r.payoutStatus,
    })),
    payouts: payouts.map(payoutView),
  };
}

// ------------------------------------------------------------- merchant --

const me = Router();
me.use(authenticate);

me.get('/', asyncHandler(async (req, res) => res.json(await overview(req.user))));

me.post(
  '/join',
  asyncHandler(async (req, res) => {
    const settings = await program();
    if (!(await ownCode(req.user.id))) {
      if (!settings.open) throw new AppError('REFERRAL_PROGRAM_CLOSED', 'The referral program is not open yet', 409);
      await db.sequelize.transaction(async (transaction) => {
        const code = await db.ReferralCode.create(
          {
            agentId: req.user.id,
            code: await newCodeFor(req.user, transaction),
            // Marks the merchant program's codes apart from the agents'.
            label: 'merchant',
            discountType: 'none',
            commissionRateBp: settings.rateBp,
            active: true,
            createdByUserId: req.user.id,
          },
          { transaction }
        );
        await recordAudit({ actorUserId: req.user.id, action: 'referral_code.merchant_join', entityType: 'ReferralCode', entityId: code.id, after: { code: code.code, rateBp: code.commissionRateBp }, req, transaction });
      });
    }
    res.status(201).json(await overview(req.user));
  })
);

me.post(
  '/payouts',
  validate({ body: Joi.object({ method: Joi.string().valid(...METHODS).required(), details: Joi.string().trim().min(5).max(300).required() }) }),
  asyncHandler(async (req, res) => {
    const code = await ownCode(req.user.id);
    if (!code) throw new NotFoundError('Referral code');
    const open = await db.ReferralPayoutRequest.findOne({ where: { userId: req.user.id, status: 'requested' } });
    if (open) throw new ConflictError('You already have a payout request waiting', 'PAYOUT_ALREADY_REQUESTED');
    const owed = (await commissions.totalsFor({ agentId: req.user.id, codeId: code.id })).filter((t) => t.pending > 0);
    if (owed.length === 0) throw new AppError('NOTHING_TO_PAY', 'There is nothing owed to you yet', 409);
    const request = await db.ReferralPayoutRequest.create({
      userId: req.user.id,
      amounts: owed.map((t) => ({ currency: t.currency, amount: t.pending })),
      method: req.body.method,
      details: req.body.details,
    });
    await recordAudit({ actorUserId: req.user.id, action: 'referral_payout.request', entityType: 'ReferralPayoutRequest', entityId: request.id, after: { amounts: request.amounts, method: request.method }, req });
    res.status(201).json(await overview(req.user));
  })
);

// ------------------------------------------------------------- console --

const admin = Router();

admin.get(
  '/referral-program',
  can(P.AGENTS_VIEW),
  asyncHandler(async (req, res) => {
    const requests = await db.ReferralPayoutRequest.findAll({
      order: [
        [db.sequelize.literal(`CASE WHEN status = 'requested' THEN 0 ELSE 1 END`), 'ASC'],
        ['createdAt', 'DESC'],
      ],
      limit: 100,
    });
    const users = await db.User.findAll({ where: { id: [...new Set(requests.map((r) => r.userId))] }, attributes: ['id', 'fullName', 'email'] });
    const byId = new Map(users.map((u) => [u.id, u]));
    const members = await db.ReferralCode.count({ where: { label: 'merchant' } });
    res.json({
      program: await program(),
      members,
      payouts: requests.map((r) => ({ ...payoutView(r), user: byId.has(r.userId) ? { id: r.userId, fullName: byId.get(r.userId).fullName, email: byId.get(r.userId).email } : null })),
    });
  })
);

admin.put(
  '/referral-program',
  can(P.AGENTS_MANAGE),
  validate({ body: Joi.object({ open: Joi.boolean().required(), rateBp: Joi.number().integer().min(0).max(10000).allow(null).required() }) }),
  asyncHandler(async (req, res) => {
    const before = await program();
    const [row] = await db.PlatformSetting.findOrCreate({ where: { key: SETTING_KEY }, defaults: { key: SETTING_KEY, value: {} } });
    await row.update({ value: { open: req.body.open, rateBp: req.body.rateBp }, updatedBy: req.user.id });
    const after = await program();
    await recordAudit({ actorUserId: req.user.id, action: 'platform.referral_program_update', entityType: 'PlatformSetting', entityId: SETTING_KEY, before, after, req });
    res.json({ program: after });
  })
);

admin.post(
  '/referral-program/payouts/:payoutId/:outcome',
  can(P.COMMISSIONS_MARK_PAID),
  validate({
    params: Joi.object({ payoutId: Joi.string().uuid().required(), outcome: Joi.string().valid('paid', 'rejected').required() }),
    body: Joi.object({ note: Joi.string().trim().max(500).allow('', null) }),
  }),
  asyncHandler(async (req, res) => {
    const request = await db.ReferralPayoutRequest.findByPk(req.params.payoutId);
    if (!request) throw new NotFoundError('Payout request');
    if (request.status !== 'requested') throw new ConflictError('This request was already handled', 'PAYOUT_ALREADY_HANDLED');
    const note = (req.body.note || '').trim() || null;
    if (req.params.outcome === 'paid') {
      // What was owed when they asked is what was paid: those ledger rows are marked paid.
      const rows = await db.AgentCommission.findAll({
        where: { agentId: request.userId, payoutStatus: 'pending', voidedAt: null, createdAt: { [Op.lte]: request.createdAt } },
        attributes: ['id'],
      });
      for (const row of rows) await commissions.markPaid(row.id, { note: note || `Payout request ${request.id}` }, req);
    }
    await request.update({ status: req.params.outcome, note, handledBy: req.user.id, handledAt: new Date() });
    await recordAudit({ actorUserId: req.user.id, action: `referral_payout.${req.params.outcome}`, entityType: 'ReferralPayoutRequest', entityId: request.id, after: { status: request.status, note }, req });
    res.json({ payout: payoutView(request) });
  })
);

module.exports = { me, admin, program };
