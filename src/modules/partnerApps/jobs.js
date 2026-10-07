'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const { send } = require('../webhooks/webhookSender');

/*
 * Telling a partner app it was uninstalled (spec-gaps item 267). On every
 * app.uninstalled event of an install that came through OAuth, the app's
 * uninstall_url gets
 *   POST { event: "app.uninstalled", store_id, install_id, reason, uninstalled_at }
 *   X-Zimos-Hmac-Sha256: hex HMAC-SHA256 of the raw body with the client secret
 * retried on the webhooks schedule (up to a day) until it answers 2xx.
 * A re-approval (the app just got a new token) is not an uninstall: not sent.
 */

async function notifyUninstall(event) {
  const { installId, reason } = event.payload || {};
  if (reason === 'reauthorized') return null;
  const record = await db.WorkspaceApp.findByPk(installId);
  const partnerAppId = record && record.external && record.external.partnerAppId;
  if (!partnerAppId) return null;
  const app = await db.PartnerApp.findByPk(partnerAppId);
  if (!app || !app.uninstallUrl) return null;
  const body = JSON.stringify({
    event: 'app.uninstalled',
    store_id: record.workspaceId,
    install_id: record.id,
    reason: reason || 'uninstalled_by_store',
    uninstalled_at: (record.uninstalledAt || new Date()).toISOString(),
  });
  const hmac = crypto.createHmac('sha256', secretBox.open(app.clientSecretSealed)).update(body).digest('hex');
  const result = await send({
    url: app.uninstallUrl,
    body,
    timeoutMs: env.webhooks.timeoutMs,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Zimos-Apps/1.0', 'X-Zimos-Event': 'app.uninstalled', 'X-Zimos-Hmac-Sha256': hmac },
  });
  const ok = result.status !== null && result.status >= 200 && result.status < 300;
  if (!ok) {
    logger.warn('[partnerApps] uninstall notice not accepted', { installId, status: result.status, error: result.error });
    // Thrown so the queue tries again later.
    throw new Error(`The app did not accept the uninstall notice (${result.error || `HTTP ${result.status}`})`);
  }
  return { delivered: true };
}

module.exports = {
  consumers: [{ name: 'partner_app_uninstalled', queue: 'webhooks', events: ['app.uninstalled'], handle: notifyUninstall }],
  notifyUninstall,
};
