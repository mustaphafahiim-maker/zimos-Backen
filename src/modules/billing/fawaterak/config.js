'use strict';

const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');

/**
 * Zimos's Fawaterak account, as env.billing.fawaterak describes it, checked.
 * Read on every call rather than once at boot, so a test can set fake values
 * on the env object at runtime.
 *
 * The base URLs are the two the API reference documents (OpenAPI `servers`).
 * The token URL must be on the base URL's origin: the client secret is sent
 * to it, and a typo there must never send it anywhere else.
 */

const BASE_URLS = {
  staging: 'https://staging.fawaterk.com',
  live: 'https://app.fawaterk.com',
};

// Our own path secret, generated with `openssl rand -hex 32`.
const MIN_WEBHOOK_TOKEN_LENGTH = 32;

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch (err) {
    return null;
  }
}

/**
 * @returns {{ ready: boolean, missing: string[], problems: string[], mode,
 *             baseUrl, tokenUrl, clientId, clientSecret, hashKey, webhookToken }}
 * `missing` and `problems` name variables, never values.
 */
function resolveConfig(raw = env.billing.fawaterak) {
  const problems = [];
  const mode = raw.env;
  if (!BASE_URLS[mode]) problems.push('FAWATERAK_ENV must be "staging" or "live"');

  const baseUrl = (raw.baseUrl || BASE_URLS[mode] || '').replace(/\/+$/, '');
  const baseOrigin = httpsOrigin(baseUrl);
  if (!baseOrigin) problems.push('FAWATERAK_BASE_URL must be an https URL');

  const tokenUrl = raw.tokenUrl || (baseUrl ? `${baseUrl}/oauth/token` : '');
  if (raw.tokenUrl && (!baseOrigin || httpsOrigin(raw.tokenUrl) !== baseOrigin)) {
    problems.push('FAWATERAK_TOKEN_URL must be an https URL on the same origin as the base URL');
  }

  const missing = [
    ['FAWATERAK_CLIENT_ID', raw.clientId],
    ['FAWATERAK_CLIENT_SECRET', raw.clientSecret],
    ['FAWATERAK_HASH_KEY', raw.hashKey],
    ['FAWATERAK_WEBHOOK_TOKEN', raw.webhookToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (raw.webhookToken && raw.webhookToken.length < MIN_WEBHOOK_TOKEN_LENGTH) {
    problems.push(`FAWATERAK_WEBHOOK_TOKEN must be at least ${MIN_WEBHOOK_TOKEN_LENGTH} characters`);
  }

  return {
    ready: problems.length === 0 && missing.length === 0,
    missing,
    problems,
    mode,
    baseUrl,
    tokenUrl,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    hashKey: raw.hashKey,
    webhookToken: raw.webhookToken,
  };
}

// One error line per distinct problem per process, not one per request.
const reported = new Set();

/** The config when it is complete; otherwise null, with the reason logged once. */
function readyConfig() {
  const config = resolveConfig();
  if (config.ready) return config;
  const reason = [...config.problems, ...config.missing.map((name) => `${name} is not set`)].join('; ');
  if (!reported.has(reason)) {
    reported.add(reason);
    logger.error(`Fawaterak billing is not configured: ${reason}. Online subscription payment is unavailable.`);
  }
  return null;
}

/** Whether a merchant may start an online payment now. */
function onlinePaymentEnabled() {
  return env.billing.online.enabled === true && Boolean(readyConfig());
}

module.exports = { BASE_URLS, MIN_WEBHOOK_TOKEN_LENGTH, resolveConfig, readyConfig, onlinePaymentEnabled };
