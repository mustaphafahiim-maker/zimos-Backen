'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { trackingLimiter } = require('../../core/middleware/rateLimiters');

/*
 * Store gates (spec-gaps item 197). settings.store_gate =
 *   { mode: off | password | coming_soon, passwordHash, passwordVersion,
 *     message, opensAt, ageCheck: { enabled, minAge, message } }
 *
 * - password / coming_soon lock the store's own routes server-side
 *   (resolvePublicWorkspace calls `enforce`): products, pages, cart,
 *   checkout, blog… answer 423 STORE_LOCKED. The store's metadata (with the
 *   gate), the gate's own routes, analytics events, fonts, and what existing
 *   customers already have (order tracking and payment returns, downloads,
 *   courses, subscriptions, affiliate portal) stay open, and so do funnels
 *   unless `lockFunnels`. Staff with a preview token pass.
 * - password: the right password gives a token (X-Store-Gate), 30 days,
 *   void when the password changes. coming_soon: no password, an email
 *   sign-up instead (both modes take sign-ups).
 * - ageCheck is a notice the storefront shows before entering (a shopper's
 *   own answer; it cannot be verified) — not a lock.
 */

const MODES = ['off', 'password', 'coming_soon'];
const TOKEN_TTL_MS = 30 * 864e5;
const OPEN = /^\/(gate|visitor-context|events|fonts|custom-code|downloads|learn|subscriptions|affiliate)(\/|$|\?)|^\/orders\/|^\/marketing\/unsubscribe/;

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.store_gate) || {};
  return {
    mode: MODES.includes(s.mode) ? s.mode : 'off',
    hasPassword: Boolean(s.passwordHash),
    passwordVersion: s.passwordVersion || 0,
    passwordHash: s.passwordHash || null,
    message: s.message || null,
    opensAt: s.opensAt || null,
    lockFunnels: Boolean(s.lockFunnels),
    ageCheck: s.ageCheck && s.ageCheck.enabled ? { enabled: true, minAge: s.ageCheck.minAge || 18, message: s.ageCheck.message || null } : { enabled: false },
  };
}

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
};
const passwordOk = (password, stored) => {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
};
const key = () => crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:store-gate').digest();
const sign = (body) => crypto.createHmac('sha256', key()).update(body).digest('hex');

function issueToken(workspaceId, version) {
  const body = `${workspaceId}.${version}.${Date.now() + TOKEN_TTL_MS}`;
  return `${body}.${sign(body)}`;
}
function tokenValid(token, workspaceId, version) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return false;
  const [ws, v, exp, sig] = parts;
  if (ws !== workspaceId || Number(v) !== Number(version) || Number(exp) < Date.now()) return false;
  const expected = sign(parts.slice(0, 3).join('.'));
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** resolvePublicWorkspace: 423 STORE_LOCKED for a locked store's own routes. */
function enforce(req, workspace) {
  const s = settingsOf(workspace);
  if (s.mode === 'off') return;
  const rest = String(req.originalUrl || '').replace(/^\/api\/v\d+\/store\/[^/?]+/, '');
  if (rest === '' || rest === '/' || rest.startsWith('?') || OPEN.test(rest)) return;
  if (!s.lockFunnels && /^\/funnels(\/|$|\?)/.test(rest)) return;
  if (require('../../core/security/storePreview').isStorePreviewRequest(req, workspace.id)) return;
  if (s.mode === 'password' && tokenValid(req.headers['x-store-gate'], workspace.id, s.passwordVersion)) return;
  throw new AppError('STORE_LOCKED', s.mode === 'coming_soon' ? 'This store opens soon' : 'This store is password protected', 423, { gate: publicView(workspace) });
}

function publicView(workspace) {
  const s = settingsOf(workspace);
  return { mode: s.mode, message: s.message, opensAt: s.opensAt, lockFunnels: s.lockFunnels, ageCheck: s.ageCheck };
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/store/:workspaceId/gate (open while locked).
const store = Router({ mergeParams: true });
const sp = Joi.object({ workspaceId: Joi.string().required() });
store.get('/', resolvePublicWorkspace, validate({ params: sp }), (req, res) => res.json({ gate: publicView(req.publicWorkspace) }));
store.post(
  '/unlock',
  trackingLimiter,
  resolvePublicWorkspace,
  validate({ params: sp, body: Joi.object({ password: Joi.string().min(1).max(200).required() }) }),
  asyncHandler(async (req, res) => {
    const s = settingsOf(req.publicWorkspace);
    if (s.mode !== 'password' || !passwordOk(req.body.password, s.passwordHash)) throw new AppError('WRONG_PASSWORD', 'That password is not right', 422, [{ field: 'password', message: 'That password is not right' }]);
    res.json({ token: issueToken(req.publicWorkspace.id, s.passwordVersion), expiresInSeconds: TOKEN_TTL_MS / 1000 });
  })
);
store.post(
  '/signup',
  trackingLimiter,
  resolvePublicWorkspace,
  validate({ params: sp, body: Joi.object({ email: Joi.string().trim().email().max(255).required(), locale: Joi.string().valid('ar', 'en', 'fr') }) }),
  asyncHandler(async (req, res) => {
    if (settingsOf(req.publicWorkspace).mode === 'off') throw new AppError('STORE_OPEN', 'The store is open', 409);
    await db.StoreGateSignup.findOrCreate({
      where: { workspaceId: req.publicWorkspace.id, email: req.body.email.toLowerCase() },
      defaults: { workspaceId: req.publicWorkspace.id, email: req.body.email.toLowerCase(), locale: req.body.locale || null, requestIp: req.ip },
    });
    res.status(201).json({ signedUp: true });
  })
);

// Mounted at /api/v1/workspaces/:workspaceId/store-gate (website.publish: it decides who can see the store).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_PUBLISH));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
const staffView = (workspace) => {
  const { passwordHash, passwordVersion, ...rest } = settingsOf(workspace);
  return rest;
};
staff.get('/', validate({ params: ws }), asyncHandler(async (req, res) => res.json(staffView(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] })))));
staff.put(
  '/',
  validate({
    params: ws,
    body: Joi.object({
      mode: Joi.string().valid(...MODES).required(),
      password: Joi.string().min(4).max(100),
      message: Joi.string().trim().max(500).allow('', null),
      opensAt: Joi.date().iso().allow(null),
      lockFunnels: Joi.boolean(),
      ageCheck: Joi.object({ enabled: Joi.boolean().required(), minAge: Joi.number().integer().min(13).max(25), message: Joi.string().trim().max(300).allow('', null) }),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const cur = (workspace.settings && workspace.settings.store_gate) || {};
    if (req.body.mode === 'password' && !req.body.password && !cur.passwordHash) {
      throw new AppError('VALIDATION_ERROR', 'Choose a password', 422, [{ field: 'password', message: 'Required to lock the store with a password' }]);
    }
    const next = {
      ...cur,
      mode: req.body.mode,
      ...(req.body.password ? { passwordHash: hashPassword(req.body.password), passwordVersion: (cur.passwordVersion || 0) + 1 } : {}),
      ...(req.body.message !== undefined ? { message: req.body.message || null } : {}),
      ...(req.body.opensAt !== undefined ? { opensAt: req.body.opensAt ? new Date(req.body.opensAt).toISOString() : null } : {}),
      ...(req.body.lockFunnels !== undefined ? { lockFunnels: req.body.lockFunnels } : {}),
      ...(req.body.ageCheck ? { ageCheck: req.body.ageCheck } : {}),
    };
    await workspace.update({ settings: { ...(workspace.settings || {}), store_gate: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'store_gate.update', entityType: 'Workspace', entityId: workspace.id, after: { mode: next.mode, passwordChanged: Boolean(req.body.password), ageCheck: Boolean(next.ageCheck && next.ageCheck.enabled) }, req });
    res.json(staffView(workspace));
  })
);
staff.get('/signups', validate({ params: ws }), asyncHandler(async (req, res) => {
  const rows = await db.StoreGateSignup.findAll({ where: { workspaceId: req.tenant.workspaceId }, order: [['createdAt', 'DESC']], limit: 5000 });
  res.json({ signups: rows.map((r) => ({ email: r.email, locale: r.locale, createdAt: r.createdAt, notifiedAt: r.notifiedAt })), total: rows.length });
}));

module.exports = { store, staff, enforce, publicView, settingsOf };
