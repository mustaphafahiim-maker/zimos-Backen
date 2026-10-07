'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');

/*
 * Spin to win (spec-gaps item 258), an honest one (SPEC §21):
 *   settings.spin_wheel = { enabled, title, text, delaySeconds,
 *     slices: [{ id, label, discountId | null, weight }] }   (2–12 slices)
 * The draw happens on the server with crypto randomness, by the slices'
 * weights, and the storefront shows every slice's real chance (`chance`, %).
 * A slice is a real coupon of the store (with a code), or no prize ("better
 * luck next time"); a coupon that has ended or run out leaves the draw, and
 * the chances are shown without it. One spin per phone number: the shopper
 * gives their phone and ticks consent to hear from the store (a contact
 * tagged `spin_wheel`, like the newsletter); a second spin answers 409.
 */

const KEY = 'spin_wheel';
const TAG = 'spin_wheel';
const text = (max) => Joi.string().trim().max(max).allow('', null);

const sliceSchema = Joi.object({
  id: Joi.string().max(40),
  label: Joi.string().trim().min(1).max(40).required(),
  discountId: Joi.string().uuid().allow(null).default(null),
  weight: Joi.number().integer().min(0).max(1000).required(),
});
const configSchema = Joi.object({
  enabled: Joi.boolean().required(),
  title: text(120),
  text: text(300),
  delaySeconds: Joi.number().integer().min(0).max(600).default(10),
  slices: Joi.array().items(sliceSchema).min(2).max(12).required(),
});

const configOf = (workspace) => (workspace.settings && workspace.settings[KEY]) || null;

async function liveCoupons(workspaceId, ids) {
  if (!ids.length) return new Map();
  const now = new Date();
  const ds = await db.Discount.findAll({ where: { id: ids, workspaceId, status: 'active' } });
  return new Map(ds.filter((d) => d.code && (!d.startsAt || d.startsAt <= now) && (!d.endsAt || d.endsAt > now) && (d.usageLimit === null || d.usageCount < d.usageLimit)).map((d) => [d.id, d]));
}

/** The slices in the draw now, with their real chance. */
async function drawable(workspaceId, config) {
  const coupons = await liveCoupons(workspaceId, config.slices.map((s) => s.discountId).filter(Boolean));
  const inDraw = config.slices.filter((s) => s.weight > 0 && (!s.discountId || coupons.has(s.discountId)));
  const total = inDraw.reduce((n, s) => n + s.weight, 0);
  return { inDraw, total, coupons };
}

async function publicView(workspace) {
  const config = configOf(workspace);
  if (!config || !config.enabled) return null;
  const { inDraw, total } = await drawable(workspace.id, config);
  // Only prizes can't be drawn: no wheel rather than a wheel that always loses.
  if (!total || !inDraw.some((s) => s.discountId)) return null;
  return {
    title: config.title || null,
    text: config.text || null,
    delaySeconds: config.delaySeconds,
    slices: inDraw.map((s) => ({ id: s.id, label: s.label, prize: Boolean(s.discountId), chance: Math.round((s.weight / total) * 1000) / 10 })),
  };
}

async function spin(workspace, body) {
  const config = configOf(workspace);
  if (!config || !config.enabled) throw new AppError('SPIN_WHEEL_OFF', 'This store has no wheel', 404);
  if (body.website) return { sliceId: null, label: null, prize: false, couponCode: null };
  const phoneNormalized = normalizePhone(body.phone);
  if (!phoneNormalized) throw new ValidationError([{ field: 'phone', message: 'Enter a valid mobile number' }]);
  const { inDraw, total, coupons } = await drawable(workspace.id, config);
  if (!total || !inDraw.some((s) => s.discountId)) throw new AppError('SPIN_WHEEL_OFF', 'This store has no wheel', 404);

  return db.sequelize.transaction(async (transaction) => {
    // One spin per phone, even with two tabs at once.
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `spin:${workspace.id}:${phoneNormalized}` }, transaction });
    const existing = await db.Customer.findOne({ where: { workspaceId: workspace.id, phoneNormalized }, transaction });
    if (existing && (existing.tags || []).includes(TAG)) throw new AppError('ALREADY_SPUN', 'This number has already spun the wheel', 409);

    let roll = crypto.randomInt(total);
    const slice = inDraw.find((s) => (roll -= s.weight) < 0);
    const coupon = slice.discountId ? coupons.get(slice.discountId) : null;

    if (existing) {
      await existing.update({ marketingConsent: true, fullName: existing.fullName || body.fullName || null, tags: [...new Set([...(existing.tags || []), TAG])] }, { transaction });
    } else {
      await require('../billing/limitGuards').assertLeadRoom(workspace.id, phoneNormalized);
      const lead = await db.Customer.create({ workspaceId: workspace.id, phoneNormalized, phoneRaw: body.phone, fullName: body.fullName || null, marketingConsent: true, tags: [TAG], source: 'spin_wheel' }, { transaction });
      await require('../../core/outbox/outbox').record(transaction, 'lead.created', { workspaceId: workspace.id, customerId: lead.id, source: 'spin_wheel' });
    }
    // Spinning with consent is opting back in after an earlier STOP (whatsapp/optOut.js).
    await db.MarketingOptOut.destroy({ where: { workspaceId: workspace.id, phoneNormalized }, transaction });
    await recordAudit({ workspaceId: workspace.id, actorUserId: null, action: 'spin_wheel.spin', entityType: 'Workspace', entityId: workspace.id, after: { sliceId: slice.id, label: slice.label, discountId: slice.discountId || null }, transaction });
    return { sliceId: slice.id, label: slice.label, prize: Boolean(coupon), couponCode: coupon ? coupon.code : null };
  });
}

// ----------------------------------------------------------------- staff --

const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });

staff.get('/', requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), validate({ params: ws }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  const config = configOf(w);
  const [spins] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS spins, COUNT(*) FILTER (WHERE after_state->>'discountId' IS NOT NULL)::int AS prizes
       FROM audit_logs WHERE workspace_id = :ws AND action = 'spin_wheel.spin'`,
    { replacements: { ws: w.id }, type: db.Sequelize.QueryTypes.SELECT }
  );
  res.json({ config, preview: config ? await publicView({ ...w.get(), settings: { [KEY]: { ...config, enabled: true } } }) : null, stats: spins });
}));

staff.put('/', requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), validate({ params: ws, body: configSchema }), asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const config = { ...req.body, title: req.body.title || null, text: req.body.text || null, slices: req.body.slices.map((s) => ({ ...s, id: s.id || crypto.randomUUID() })) };
  const ids = [...new Set(config.slices.map((s) => s.discountId).filter(Boolean))];
  if (ids.length) {
    const ds = await db.Discount.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'code'] });
    if (ds.length !== ids.length || ds.some((d) => !d.code)) throw new ValidationError([{ field: 'slices', message: 'Every prize must be one of the store’s discounts with a code' }]);
  }
  if (!config.slices.some((s) => s.discountId && s.weight > 0)) throw new ValidationError([{ field: 'slices', message: 'At least one prize needs a chance above 0' }]);
  const workspace = await db.Workspace.findByPk(workspaceId);
  await workspace.update({ settings: { ...(workspace.settings || {}), [KEY]: config } });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'spin_wheel.update', entityType: 'Workspace', entityId: workspaceId, after: { enabled: config.enabled, slices: config.slices.length }, req });
  res.json({ config });
}));

// --------------------------------------------------------------- storefront --

const store = Router({ mergeParams: true });
store.get('/', resolvePublicWorkspace, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ wheel: await publicView(req.publicWorkspace) });
}));
store.post('/spin', resolvePublicWorkspace, validate({
  body: Joi.object({
    phone: Joi.string().trim().min(6).max(32).required(),
    fullName: text(200),
    // The shopper ticks "send me offers": the wheel is a sign-up, said so on its face.
    marketingConsent: Joi.boolean().valid(true).required(),
    website: Joi.string().max(500).allow('', null),
  }),
}), asyncHandler(async (req, res) => {
  res.status(201).json(await spin(req.publicWorkspace, req.body));
}));

module.exports = { staff, store, spin, publicView };
