'use strict';

const env = require('../../../../config/env');
const webhookSender = require('../../../webhooks/webhookSender');

// Telegram, Slack and Discord answer within a second or two; the whole exchange is capped (item 318).
const TIMEOUT_MS = Math.min(env.webhooks.timeoutMs, 8000);

/**
 * One JSON POST through webhookSender: its connect-time address check
 * (webhookUrlGuard.guardedLookup), no redirects, and a deadline on the whole
 * exchange. Resolves when the service answered 2xx; otherwise throws an Error
 * whose message names the service and its status, never the URL (it holds
 * the secret).
 */
async function postJson(service, url, payload) {
  const result = await webhookSender.send({
    url,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ZIMOS-Alerts/1.0' },
    timeoutMs: TIMEOUT_MS,
  });
  if (result.status && result.status >= 200 && result.status < 300) return { status: result.status };
  const err = new Error(
    result.status ? `${service} answered ${result.status}` : `${service} could not be reached: ${String(result.error || 'no answer').slice(0, 200)}`
  );
  // 400/401/403/404: the token, chat or webhook is wrong or was removed — retrying will not help.
  err.permanent = Boolean(result.status && [400, 401, 403, 404, 410].includes(result.status));
  throw err;
}

module.exports = { postJson };
