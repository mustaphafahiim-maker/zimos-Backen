'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const { AppError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const { trackingLimiter } = require('../../../core/middleware/rateLimiters');

// Sign in with Google for shopper accounts (spec-gaps item 217) — see README.md.

function adapter() {
  if (process.env.SHOPPER_GOOGLE_MODE === 'sandbox' && !env.isProduction) return require('./sandbox');
  return require('./google');
}

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.shopper_google) || {};
  const clientId = s.clientId || env.google.clientId || null;
  return { enabled: Boolean(s.enabled) && Boolean(clientId || adapter().name === 'sandbox'), ownClientId: s.clientId || null, clientId };
}

/*
 * The store's sign-in nonce (item 279): GET …/account/google hands one to the
 * button, Google puts it in the ID token, and signing in checks it — so a token
 * minted on one store (all stores without their own client id share the
 * platform's) can't be replayed on another. "<unix seconds>.<HMAC(store|time)>",
 * good for 10 minutes; nothing is stored.
 */
const NONCE_TTL_S = 10 * 60;
const nonceKey = () => crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:shopper-google-nonce').digest();
const nonceSig = (workspaceId, ts) => crypto.createHmac('sha256', nonceKey()).update(`${workspaceId}|${ts}`).digest('hex');
function issueNonce(workspaceId, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  return `${ts}.${nonceSig(workspaceId, ts)}`;
}
function nonceValid(workspaceId, nonce, now = Date.now()) {
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(String(nonce || ''));
  if (!m) return false;
  const age = Math.floor(now / 1000) - Number(m[1]);
  if (age < 0 || age > NONCE_TTL_S) return false;
  const want = Buffer.from(nonceSig(workspaceId, m[1]), 'hex');
  const got = Buffer.from(m[2], 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

async function signIn(workspace, idToken, req) {
  const accounts = require('..').settingsOf(workspace);
  const s = settingsOf(workspace);
  if (!accounts.enabled || !s.enabled) throw new AppError('GOOGLE_SIGN_IN_OFF', 'This store does not offer Google sign-in', 404);
  let who;
  try {
    who = await adapter().verify(idToken, s.clientId);
  } catch (err) {
    logger.info(`[shopper-google] refused: ${err.message}`);
    throw new AppError('GOOGLE_TOKEN_INVALID', 'Google sign-in did not work — try again', 401);
  }
  // Minted for this store's button (item 279).
  if (!nonceValid(workspace.id, who.nonce)) throw new AppError('GOOGLE_TOKEN_INVALID', 'Google sign-in did not work — try again', 401);
  if (!who.email || !who.emailVerified) throw new AppError('GOOGLE_EMAIL_UNVERIFIED', 'Your Google account has no verified email', 422);
  const auth0 = require('../shopperAuth');
  // Already signed in (by phone): Google proves the email, which becomes this shopper's verified email (item 278).
  const current = req && req.headers && req.headers['x-shopper-token'] ? await auth0.readToken(workspace.id, req.headers['x-shopper-token']) : null;
  if (current) {
    await current.update({ email: String(who.email).toLowerCase(), emailVerifiedAt: new Date(), lastLoginAt: new Date(), ...(current.fullName ? {} : who.name ? { fullName: who.name } : {}) });
    if (req) req.shopper = current;
    return { token: auth0.signToken(workspace.id, current), expiresInSeconds: 30 * 86400, linked: true, customer: { id: current.id, fullName: current.fullName, email: current.email } };
  }
  // Otherwise only a contact whose email was verified (item 278): an email typed at checkout next to someone's phone proves nothing.
  const customer = await db.Customer.findOne({ where: { workspaceId: workspace.id, emailVerifiedAt: { [db.Sequelize.Op.ne]: null }, [db.Sequelize.Op.and]: [db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('email')), who.email)] }, order: [['createdAt', 'ASC']] });
  if (!customer) throw new AppError('ACCOUNT_NOT_FOUND', 'No account with this email yet — sign in with your phone, then add Google from your account', 404);
  await customer.update({ lastLoginAt: new Date(), ...(customer.fullName ? {} : who.name ? { fullName: who.name } : {}) });
  const auth = require('../shopperAuth');
  if (req) req.shopper = customer;
  return { token: auth.signToken(workspace.id, customer), expiresInSeconds: 30 * 86400, customer: { id: customer.id, fullName: customer.fullName, email: customer.email } };
}

// Mounted at /api/v1/store/:workspaceId/account/google.
const store = Router({ mergeParams: true });
const sp = Joi.object({ workspaceId: Joi.string().required() });
store.get('/', resolvePublicWorkspace, validate({ params: sp }), (req, res) => {
  const s = settingsOf(req.publicWorkspace);
  const on = s.enabled && require('..').settingsOf(req.publicWorkspace).enabled;
  res.set('Cache-Control', 'no-store');
  // nonce: pass it to Google's button (initialize({ nonce })); valid 10 minutes (item 279).
  res.json({ enabled: on, clientId: s.enabled ? s.clientId : null, nonce: on ? issueNonce(req.publicWorkspace.id) : null });
});
store.post('/', trackingLimiter, resolvePublicWorkspace, validate({ params: sp, body: Joi.object({ idToken: Joi.string().min(10).max(5000).required() }) }), asyncHandler(async (req, res) => res.json(await signIn(req.publicWorkspace, req.body.idToken, req))));

// Mounted at /api/v1/workspaces/:workspaceId/shopper-accounts/google (workspace.manage).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', validate({ params: ws }), asyncHandler(async (req, res) => {
  const s = settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] }));
  res.json({ enabled: s.enabled, clientId: s.ownClientId, platformClientAvailable: Boolean(env.google.clientId) });
}));
staff.put(
  '/',
  validate({ params: ws, body: Joi.object({ enabled: Joi.boolean().required(), clientId: Joi.string().trim().pattern(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/).allow(null, '').messages({ 'string.pattern.base': 'Paste the web client id, ending in .apps.googleusercontent.com' }) }) }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const next = { enabled: req.body.enabled, clientId: req.body.clientId || null };
    if (next.enabled && !next.clientId && !env.google.clientId && adapter().name !== 'sandbox') {
      throw new AppError('VALIDATION_ERROR', 'Add your Google client id', 422, [{ field: 'clientId', message: 'Required: the platform has no Google client' }]);
    }
    await workspace.update({ settings: { ...(workspace.settings || {}), shopper_google: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'shopper_google.update', entityType: 'Workspace', entityId: workspace.id, after: next, req });
    const s = settingsOf(workspace);
    res.json({ enabled: s.enabled, clientId: s.ownClientId, platformClientAvailable: Boolean(env.google.clientId) });
  })
);

module.exports = { store, staff, signIn, settingsOf };
