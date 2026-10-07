'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { authLimiter } = require('../../core/middleware/rateLimiters');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');
const { recordAudit } = require('../audit/auditService');
const outbox = require('../../core/outbox/outbox');
const apiKeyService = require('../apiKeys/apiKeyService');

/*
 * Partner apps with OAuth (spec-gaps item 265, SPEC §16.3 — Lightfunnels'
 * app platform). App charges stay out (§17.4).
 *
 *   1. A developer (any ZIMOS account) registers an app: name, icon, the page
 *      shown inside the dashboard (app_url), redirect addresses, the scopes
 *      it may ask for. It gets a client id and a client secret (shown once).
 *      A new app is `development`: only stores its developer belongs to can
 *      install it, until the platform publishes it.
 *   2. The app sends the merchant to the dashboard's
 *      /oauth/authorize?client_id=…&redirect_uri=…&scope=orders:read,…&state=…
 *      The dashboard shows the app and the scopes (GET …/oauth/authorize) and,
 *      on approval (POST), sends the browser back to redirect_uri with a code
 *      (10 minutes, one use), the state and the store id.
 *   3. The app's server swaps the code for an access token: POST /oauth/token
 *      with its client id and secret. The token is a public-API key with
 *      exactly the approved scopes, acting as the person who approved (never
 *      more than their role allows), kept until the store uninstalls the app
 *      or the app revokes it (POST /oauth/revoke). Approving again replaces
 *      the token.
 *   4. Inside the dashboard the app's page opens in a frame at a signed
 *      address: app_url?store_id&user_id&timestamp&hmac, hmac = HMAC-SHA256
 *      (client secret) of the other parameters sorted by name, joined
 *      "k=v&k=v" — the app checks it and that timestamp is under 5 minutes old.
 *
 * An installation is a workspace_apps row (kind external, external.partnerAppId)
 * holding the key, so the Apps page, uninstall and the public-API gate treat
 * it like any outside app.
 */

const SCOPE_NAMES = Object.keys(apiKeyService.SCOPES);
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_APPS_PER_DEVELOPER = 20;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const newSecret = () => `zps_${crypto.randomBytes(24).toString('hex')}`;

function redirectAllowed(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}
const httpsUrl = Joi.string().trim().max(500).uri({ scheme: ['https'] });

function devView(app, { secret } = {}) {
  return {
    id: app.id, name: app.name, description: app.description, iconUrl: app.iconUrl, appUrl: app.appUrl, uninstallUrl: app.uninstallUrl,
    redirectUris: app.redirectUris, scopes: app.scopes, clientId: app.clientId, status: app.status,
    createdAt: app.createdAt, updatedAt: app.updatedAt,
    ...(secret ? { clientSecret: secret } : {}),
  };
}

const parseScopes = (raw) => [...new Set(String(raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

/** The installs of an app (a store's current one, or all). */
const installsOf = (partnerAppId, where = {}) =>
  db.WorkspaceApp.findAll({ where: { kind: 'external', status: 'installed', ...where, external: { partnerAppId } } });

/** Revokes the install's token and marks it uninstalled; tells the app's webhooks (outbox app.uninstalled). */
async function removeInstall(record, actorUserId, reason) {
  const req = { user: { id: actorUserId || record.installedByUserId }, headers: {}, ip: null };
  if (record.apiKeyId) await apiKeyService.revokeKey(record.workspaceId, record.apiKeyId, req).catch(() => {});
  await db.sequelize.transaction(async (transaction) => {
    await record.update({ status: 'uninstalled', uninstalledAt: new Date() }, { transaction });
    await recordAudit({ workspaceId: record.workspaceId, actorUserId: actorUserId || null, action: 'app.partner_uninstall', entityType: 'WorkspaceApp', entityId: record.id, before: { name: (record.external || {}).name }, after: { reason }, transaction });
    await outbox.record(transaction, 'app.uninstalled', { workspaceId: record.workspaceId, installId: record.id, name: (record.external || {}).name, reason }, { aggregateType: 'app', aggregateId: record.id });
  });
}

// ------------------------------------------------------------- developers --

const appBody = {
  name: Joi.string().trim().min(2).max(80),
  description: Joi.string().trim().max(500).allow('', null),
  iconUrl: httpsUrl.allow('', null),
  appUrl: httpsUrl.allow('', null),
  // POSTed { event: "app.uninstalled", … } when a store uninstalls the app (jobs.js, item 267).
  uninstallUrl: httpsUrl.allow('', null),
  redirectUris: Joi.array().items(Joi.string().trim().max(500)).min(1).max(10).unique(),
  scopes: Joi.array().items(Joi.string().valid(...SCOPE_NAMES)).min(1).unique(),
};
/** The server ZIMOS calls must be a public address (the webhooks' rules: no private networks). */
function checkedUninstallUrl(url) {
  if (!url) return null;
  return require('../webhooks/webhookUrlGuard').checkUrl(url);
}

function assertRedirects(uris) {
  const bad = (uris || []).filter((u) => !redirectAllowed(u));
  if (bad.length) throw new ValidationError([{ field: 'redirectUris', message: `Use https addresses (http only for localhost), without #: ${bad.join(', ')}` }]);
}

const developer = Router();
developer.use(authenticate);
const ownApp = async (req) => {
  const app = await db.PartnerApp.findOne({ where: { id: req.params.id, ownerUserId: req.user.id } });
  if (!app) throw new NotFoundError('Partner app');
  return app;
};
const idParam = Joi.object({ id: Joi.string().uuid().required() });

developer.get('/', asyncHandler(async (req, res) => {
  const apps = await db.PartnerApp.findAll({ where: { ownerUserId: req.user.id }, order: [['createdAt', 'DESC']] });
  res.json({ apps: apps.map((a) => devView(a)), scopes: SCOPE_NAMES });
}));
developer.post('/', validate({ body: Joi.object({ ...appBody, name: appBody.name.required(), redirectUris: appBody.redirectUris.required(), scopes: appBody.scopes.required() }) }), asyncHandler(async (req, res) => {
  assertRedirects(req.body.redirectUris);
  if ((await db.PartnerApp.count({ where: { ownerUserId: req.user.id } })) >= MAX_APPS_PER_DEVELOPER) throw new AppError('PARTNER_APP_LIMIT', `At most ${MAX_APPS_PER_DEVELOPER} apps per developer`, 409);
  const secret = newSecret();
  const app = await db.PartnerApp.create({
    ownerUserId: req.user.id, name: req.body.name, description: req.body.description || null, iconUrl: req.body.iconUrl || null, appUrl: req.body.appUrl || null, uninstallUrl: checkedUninstallUrl(req.body.uninstallUrl),
    redirectUris: req.body.redirectUris, scopes: req.body.scopes, clientId: `zpa_${crypto.randomBytes(12).toString('hex')}`, clientSecretSealed: secretBox.seal(secret),
  });
  await recordAudit({ actorUserId: req.user.id, action: 'partner_app.create', entityType: 'PartnerApp', entityId: app.id, after: { name: app.name, scopes: app.scopes }, req });
  res.status(201).json({ app: devView(app, { secret }) });
}));
developer.patch('/:id', validate({ params: idParam, body: Joi.object(appBody).min(1) }), asyncHandler(async (req, res) => {
  const app = await ownApp(req);
  if (req.body.redirectUris) assertRedirects(req.body.redirectUris);
  const patch = {};
  for (const k of Object.keys(appBody)) if (req.body[k] !== undefined) patch[k] = req.body[k] === '' ? null : req.body[k];
  if (patch.uninstallUrl) patch.uninstallUrl = checkedUninstallUrl(patch.uninstallUrl);
  await app.update(patch);
  await recordAudit({ actorUserId: req.user.id, action: 'partner_app.update', entityType: 'PartnerApp', entityId: app.id, after: Object.keys(patch), req });
  res.json({ app: devView(app) });
}));
developer.post('/:id/rotate-secret', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const app = await ownApp(req);
  const secret = newSecret();
  await app.update({ clientSecretSealed: secretBox.seal(secret) });
  await recordAudit({ actorUserId: req.user.id, action: 'partner_app.rotate_secret', entityType: 'PartnerApp', entityId: app.id, req });
  res.json({ app: devView(app, { secret }) });
}));
developer.get('/:id/installs', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const app = await ownApp(req);
  const rows = await installsOf(app.id);
  const stores = await db.Workspace.findAll({ where: { id: rows.map((r) => r.workspaceId) }, attributes: ['id', 'name'] });
  const names = new Map(stores.map((w) => [w.id, w.name]));
  res.json({ installs: rows.map((r) => ({ storeId: r.workspaceId, storeName: names.get(r.workspaceId) || null, scopes: (r.external || {}).scopes || [], installedAt: r.installedAt })) });
}));
developer.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const app = await ownApp(req);
  for (const record of await installsOf(app.id)) await removeInstall(record, null, 'app_deleted');
  await recordAudit({ actorUserId: req.user.id, action: 'partner_app.delete', entityType: 'PartnerApp', entityId: app.id, before: { name: app.name }, req });
  await app.destroy();
  res.json({ deleted: true });
}));

// ------------------------------------------------------------ the merchant --

/** The app behind an authorization request, checked against what it registered. */
async function resolveRequest(workspaceId, { client_id: clientId, redirect_uri: redirectUri, scope }) {
  const app = await db.PartnerApp.findOne({ where: { clientId: String(clientId || '') } });
  if (!app || app.status === 'suspended') throw new NotFoundError('App');
  if (!app.redirectUris.includes(redirectUri)) throw new ValidationError([{ field: 'redirect_uri', message: 'This address is not registered for the app' }]);
  const scopes = parseScopes(scope);
  if (!scopes.length) throw new ValidationError([{ field: 'scope', message: 'The app asks for no permission' }]);
  const extra = scopes.filter((s) => !app.scopes.includes(s));
  if (extra.length) throw new ValidationError([{ field: 'scope', message: `Not registered for the app: ${extra.join(', ')}` }]);
  if (app.status === 'development') {
    const member = await db.Membership.count({ where: { workspaceId, userId: app.ownerUserId, status: 'active' } });
    if (!member) throw new AppError('APP_IN_DEVELOPMENT', 'This app is still in development: only its developer’s stores can install it', 403);
  }
  return { app, scopes };
}

const merchant = Router({ mergeParams: true });
merchant.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.APPS_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };
const authQuery = {
  client_id: Joi.string().max(60).required(),
  redirect_uri: Joi.string().max(500).required(),
  scope: Joi.string().max(1000).required(),
  state: Joi.string().max(500).allow(''),
  response_type: Joi.string().valid('code').default('code'),
};

merchant.get('/authorize', validate({ params: Joi.object(ws), query: Joi.object(authQuery) }), asyncHandler(async (req, res) => {
  const { app, scopes } = await resolveRequest(req.tenant.workspaceId, req.query);
  const owner = await db.User.findByPk(app.ownerUserId, { attributes: ['fullName'] });
  const installed = (await installsOf(app.id, { workspaceId: req.tenant.workspaceId })).length > 0;
  res.json({
    app: { name: app.name, description: app.description, iconUrl: app.iconUrl, developer: owner ? owner.fullName : null, status: app.status, redirectHost: new URL(req.query.redirect_uri).host },
    scopes, installed,
  });
}));

merchant.post('/authorize', validate({ params: Joi.object(ws), body: Joi.object({ ...authQuery, approve: Joi.boolean().default(true) }) }), asyncHandler(async (req, res) => {
  const back = new URL(req.body.redirect_uri);
  if (!req.body.approve) {
    // Refusing still goes back to a registered address only.
    await resolveRequest(req.tenant.workspaceId, req.body);
    back.searchParams.set('error', 'access_denied');
    if (req.body.state) back.searchParams.set('state', req.body.state);
    return res.json({ redirectTo: back.toString() });
  }
  const { app, scopes } = await resolveRequest(req.tenant.workspaceId, req.body);
  const code = crypto.randomBytes(32).toString('base64url');
  await db.OAuthCode.create({ codeHash: sha256(code), partnerAppId: app.id, workspaceId: req.tenant.workspaceId, userId: req.user.id, scopes, redirectUri: req.body.redirect_uri, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'app.partner_authorize', entityType: 'PartnerApp', entityId: app.id, after: { name: app.name, scopes }, req });
  back.searchParams.set('code', code);
  if (req.body.state) back.searchParams.set('state', req.body.state);
  back.searchParams.set('store_id', req.tenant.workspaceId);
  return res.json({ redirectTo: back.toString() });
}));

// The app's page inside the dashboard: any member of the store opens it.
const embed = Router({ mergeParams: true });
embed.get('/:installId/embed', authenticate, resolveTenant, validate({ params: Joi.object({ ...ws, installId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const record = await db.WorkspaceApp.findOne({ where: { id: req.params.installId, workspaceId: req.tenant.workspaceId, kind: 'external', status: 'installed' } });
  const partnerAppId = record && record.external && record.external.partnerAppId;
  const app = partnerAppId ? await db.PartnerApp.findByPk(partnerAppId) : null;
  if (!app || !app.appUrl || app.status === 'suspended') throw new NotFoundError('App page');
  const params = { store_id: req.tenant.workspaceId, timestamp: String(Math.floor(Date.now() / 1000)), user_id: req.user.id };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', secretBox.open(app.clientSecretSealed)).update(message).digest('hex');
  const url = new URL(app.appUrl);
  for (const [k, v] of Object.entries({ ...params, hmac })) url.searchParams.set(k, v);
  res.json({ url: url.toString(), name: app.name });
}));

// ---------------------------------------------------- the app's own server --

async function appByCredentials(clientId, clientSecret) {
  const app = await db.PartnerApp.findOne({ where: { clientId: String(clientId || '') } });
  const ok = app && app.status !== 'suspended' && (() => {
    const real = Buffer.from(secretBox.open(app.clientSecretSealed));
    const given = Buffer.from(String(clientSecret || ''));
    return real.length === given.length && crypto.timingSafeEqual(real, given);
  })();
  if (!ok) throw new AppError('invalid_client', 'Unknown client or wrong secret', 401);
  return app;
}

async function exchange({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }) {
  const app = await appByCredentials(clientId, clientSecret);
  const row = await db.OAuthCode.findOne({ where: { codeHash: sha256(code || '') } });
  if (!row || row.partnerAppId !== app.id || row.redirectUri !== redirectUri || row.expiresAt < new Date()) throw new AppError('invalid_grant', 'The code is not valid', 400);
  // One use: a second try fails (and the first token stands).
  const [claimed] = await db.OAuthCode.update({ usedAt: new Date() }, { where: { id: row.id, usedAt: null } });
  if (claimed !== 1) throw new AppError('invalid_grant', 'The code was already used', 400);

  const user = await db.User.findByPk(row.userId);
  const member = user && (await db.Membership.count({ where: { workspaceId: row.workspaceId, userId: user.id, status: 'active' } }));
  if (!member) throw new AppError('invalid_grant', 'The person who approved is no longer on the store', 400);
  const req = { user: { id: user.id }, headers: {}, ip: null };
  const { apiKey, secret } = await apiKeyService.createKey(row.workspaceId, { name: `App: ${app.name}`.slice(0, 150), scopes: row.scopes }, req);
  // Approving again replaces the store's install and its token.
  for (const old of await installsOf(app.id, { workspaceId: row.workspaceId })) await removeInstall(old, user.id, 'reauthorized');
  const record = await db.WorkspaceApp.create({
    workspaceId: row.workspaceId, kind: 'external',
    external: { name: app.name, description: app.description, icon: app.iconUrl, partnerAppId: app.id, clientId: app.clientId, embedded: Boolean(app.appUrl), scopes: row.scopes },
    apiKeyId: apiKey.id, installedByUserId: user.id,
  });
  await recordAudit({ workspaceId: row.workspaceId, actorUserId: user.id, action: 'app.partner_install', entityType: 'WorkspaceApp', entityId: record.id, after: { name: app.name, scopes: row.scopes } });
  const workspace = await db.Workspace.findByPk(row.workspaceId, { attributes: ['name'] });
  return { access_token: secret, token_type: 'Bearer', scope: row.scopes.join(' '), store_id: row.workspaceId, store_name: workspace ? workspace.name : null, install_id: record.id };
}

const oauth = Router();
oauth.post('/token', authLimiter, validate({ body: Joi.object({
  grant_type: Joi.string().valid('authorization_code').required(),
  code: Joi.string().max(200).required(),
  client_id: Joi.string().max(60).required(),
  client_secret: Joi.string().max(200).required(),
  redirect_uri: Joi.string().max(500).required(),
}) }), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await exchange(req.body));
}));
// The app gives a store up: its token stops and the install goes.
oauth.post('/revoke', authLimiter, validate({ body: Joi.object({ client_id: Joi.string().max(60).required(), client_secret: Joi.string().max(200).required(), store_id: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const app = await appByCredentials(req.body.client_id, req.body.client_secret);
  const rows = await installsOf(app.id, { workspaceId: req.body.store_id });
  for (const record of rows) await removeInstall(record, null, 'revoked_by_app');
  res.json({ revoked: rows.length > 0 });
}));

// -------------------------------------------------------------- platform --

// Mounted inside /api/v1/admin: publishing a developer's app, or suspending it (its installs are removed).
const admin = Router();
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
admin.get('/partner-apps', can(P.PROVIDERS_VIEW), validate({ query: Joi.object({ status: Joi.string().valid('development', 'published', 'suspended') }) }), asyncHandler(async (req, res) => {
  const apps = await db.PartnerApp.findAll({ where: req.query.status ? { status: req.query.status } : {}, order: [['createdAt', 'DESC']], limit: 200 });
  res.json({ apps: apps.map((a) => ({ ...devView(a), clientId: a.clientId, ownerUserId: a.ownerUserId })) });
}));
admin.patch('/partner-apps/:id', can(P.PROVIDERS_MANAGE), validate({ params: idParam, body: Joi.object({ status: Joi.string().valid('development', 'published', 'suspended').required() }) }), asyncHandler(async (req, res) => {
  const app = await db.PartnerApp.findByPk(req.params.id);
  if (!app) throw new NotFoundError('Partner app');
  const before = app.status;
  await app.update({ status: req.body.status });
  if (req.body.status === 'suspended') for (const record of await installsOf(app.id)) await removeInstall(record, null, 'suspended_by_platform');
  await recordAudit({ actorUserId: req.user.id, action: 'partner_app.status', entityType: 'PartnerApp', entityId: app.id, before: { status: before }, after: { status: app.status }, req });
  res.json({ app: devView(app) });
}));

module.exports = { developer, merchant, embed, oauth, admin, exchange, resolveRequest };
