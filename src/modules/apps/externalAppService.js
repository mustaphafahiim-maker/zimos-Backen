'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const outbox = require('../../core/outbox/outbox');
const apiKeyService = require('../apiKeys/apiKeyService');
const webhookService = require('../webhooks/webhookService');
const { checkUrl } = require('../webhooks/webhookUrlGuard');
const { send } = require('../webhooks/webhookSender');
const { externalView } = require('./appService');

/**
 * The app install link (SPEC §16.3) — how an outside company (a dropshipping
 * platform, a confirmation service) connects to a store without the merchant
 * copying keys around:
 *
 *   /install-app?app_name=…&app_description=…&app_icon=…&callback_url=…
 *      &orders_webhook=…&order_status_webhook=…&permissions=orders:read,…
 *      &redirect_url=…
 *
 * The merchant sees what the app asks for and approves. ZIMOS then creates an
 * API key with exactly those scopes, registers the two webhooks, POSTs
 * { api_key, store_id, … } to callback_url, and sends the merchant back to
 * redirect_url. Everything is undone if the app's server does not accept the
 * callback, and again when the merchant uninstalls the app.
 */

const SCOPE_NAMES = Object.keys(apiKeyService.SCOPES || {});

/** Checks the link's parameters and returns them in one shape. Throws 422 with every problem found. */
function parseRequest(input) {
  const problems = [];
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const url = (field, value, required) => {
    const raw = text(value, 500);
    if (!raw) {
      if (required) problems.push({ field, message: `${field} is required` });
      return null;
    }
    try {
      return checkUrl(raw);
    } catch (err) {
      // checkUrl says which rule the address broke in its details.
      const detail = Array.isArray(err.details) && err.details[0] ? err.details[0].message : err.message;
      problems.push({ field, message: detail });
      return null;
    }
  };

  const name = text(input.app_name, 80);
  if (!name) problems.push({ field: 'app_name', message: 'app_name is required' });

  const scopes = [...new Set(text(input.permissions, 1000).split(',').map((s) => s.trim()).filter(Boolean))];
  if (scopes.length === 0) problems.push({ field: 'permissions', message: 'permissions must list at least one scope' });
  const unknown = scopes.filter((scope) => !SCOPE_NAMES.includes(scope));
  if (unknown.length > 0) problems.push({ field: 'permissions', message: `Unknown permissions: ${unknown.join(', ')}` });

  const callbackUrl = url('callback_url', input.callback_url, true);
  const ordersWebhook = url('orders_webhook', input.orders_webhook, false);
  const orderStatusWebhook = url('order_status_webhook', input.order_status_webhook, false);

  // The icon is only shown, the redirect only followed by the browser: http(s) is all that is asked of them.
  const plainUrl = (field, value) => {
    const raw = text(value, 500);
    if (!raw) return null;
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('not http');
      return parsed.toString();
    } catch (err) {
      problems.push({ field, message: `${field} must be an http(s) URL` });
      return null;
    }
  };
  const icon = plainUrl('app_icon', input.app_icon);
  const redirectUrl = plainUrl('redirect_url', input.redirect_url);

  if (problems.length > 0) throw new ValidationError(problems, 'Invalid install link');
  return { name, description: text(input.app_description, 300) || null, icon, callbackUrl, ordersWebhook, orderStatusWebhook, redirectUrl, scopes };
}

/** What the approval screen shows. Nothing is created. */
function preview(input) {
  const app = parseRequest(input);
  return {
    app: { name: app.name, description: app.description, icon: app.icon, callbackHost: new URL(app.callbackUrl).host },
    scopes: app.scopes,
    webhooks: [
      app.ordersWebhook ? { event: 'order.created', url: app.ordersWebhook } : null,
      app.orderStatusWebhook ? { event: 'order.status_changed', url: app.orderStatusWebhook } : null,
    ].filter(Boolean),
    redirectUrl: app.redirectUrl,
  };
}

async function install(workspaceId, input, req) {
  const app = parseRequest(input);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug'] });

  const created = { keyId: null, endpointIds: [] };
  const undo = async () => {
    for (const endpointId of created.endpointIds) {
      await webhookService.deleteEndpoint(workspaceId, endpointId, req).catch(() => {});
    }
    if (created.keyId) await apiKeyService.revokeKey(workspaceId, created.keyId, req).catch(() => {});
  };

  try {
    const { apiKey, secret } = await apiKeyService.createKey(workspaceId, { name: `App: ${app.name}`.slice(0, 150), scopes: app.scopes }, req);
    created.keyId = apiKey.id;

    const webhookSecrets = {};
    for (const [event, url] of [['order.created', app.ordersWebhook], ['order.status_changed', app.orderStatusWebhook]]) {
      if (!url) continue;
      const { endpoint, signingSecret } = await webhookService.createEndpoint(workspaceId, { url, events: [event] }, req);
      created.endpointIds.push(endpoint.id);
      webhookSecrets[event] = signingSecret;
    }

    const result = await send({
      url: app.callbackUrl,
      timeoutMs: env.webhooks.timeoutMs,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Zimos-Apps/1.0' },
      body: JSON.stringify({
        api_key: secret,
        store_id: workspaceId,
        store_name: workspace ? workspace.name : null,
        permissions: app.scopes,
        webhook_secrets: webhookSecrets,
      }),
    });
    const ok = result.status !== null && result.status >= 200 && result.status < 300;
    if (!ok) {
      throw new AppError(
        'APP_CALLBACK_FAILED',
        `The app did not accept the connection (${result.error || `HTTP ${result.status}`}). Nothing was installed.`,
        502
      );
    }

    const record = await db.WorkspaceApp.create({
      workspaceId,
      kind: 'external',
      external: { name: app.name, description: app.description, icon: app.icon, callbackUrl: app.callbackUrl, redirectUrl: app.redirectUrl, scopes: app.scopes },
      apiKeyId: created.keyId,
      webhookEndpointIds: created.endpointIds,
      installedByUserId: req.user.id,
    });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'app.external_install',
      entityType: 'WorkspaceApp',
      entityId: record.id,
      after: { name: app.name, scopes: app.scopes, webhooks: created.endpointIds.length, callbackHost: new URL(app.callbackUrl).host },
      req,
    });
    return { app: externalView(record), redirectUrl: app.redirectUrl };
  } catch (err) {
    await undo();
    throw err;
  }
}

/** Uninstalling revokes the app's key and removes its webhooks. */
async function uninstall(workspaceId, installId, req) {
  const record = await db.WorkspaceApp.findOne({ where: { id: installId, workspaceId, kind: 'external', status: 'installed' } });
  if (!record) throw new NotFoundError('App');
  for (const endpointId of record.webhookEndpointIds || []) {
    await webhookService.deleteEndpoint(workspaceId, endpointId, req).catch(() => {});
  }
  if (record.apiKeyId) await apiKeyService.revokeKey(workspaceId, record.apiKeyId, req).catch(() => {});
  await db.sequelize.transaction(async (transaction) => {
    await record.update({ status: 'uninstalled', uninstalledAt: new Date() }, { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'app.external_uninstall', entityType: 'WorkspaceApp', entityId: record.id, before: { name: (record.external || {}).name }, req, transaction });
    await outbox.record(transaction, 'app.uninstalled', { workspaceId, installId: record.id, name: (record.external || {}).name }, { aggregateType: 'app', aggregateId: record.id });
  });
  return { uninstalled: true };
}

module.exports = { preview, install, uninstall, parseRequest };
