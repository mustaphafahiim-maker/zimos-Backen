'use strict';

const { AppError } = require('../../../core/errors/AppError');
const logger = require('../../../core/utils/logger');
const gatewayHttp = require('../../payments/gateways/gatewayHttp');
const { GatewayError, GatewayRejectedError, sanitizeGatewayMessage } = require('../../payments/gateways/gatewayErrors');

/**
 * Fawaterak's API v3, the three calls subscription billing needs (API
 * reference: Auth token, API integration):
 *
 *   POST /oauth/token                 client_credentials -> Bearer token
 *   POST /api/v3/createTransaction    a hosted checkout link (no payment_method_id)
 *   POST /api/v3/getTransactionData   whether an intent is paid, and for how much
 *
 * The access token lives in this module's memory only: never stored, never
 * logged, never part of an error. It is reused until min(expires_in, 1 hour)
 * less a minute, concurrent callers share one token request, and a 401 from
 * the API drops it and retries the call once with a new one (a 401 means the
 * request was refused before it ran, so even a create is safe to repeat).
 * The refresh_token grant is not used: the reference makes it optional, and
 * asking again with the client credentials needs no second secret kept.
 *
 * All HTTP goes through payments/gateways/gatewayHttp.request (a timeout,
 * retries for reads only), which tests stub — the suite never reaches
 * Fawaterak.
 */

const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_MARGIN_MS = 60 * 1000;
// When a token answer has no usable expires_in.
const FALLBACK_TOKEN_TTL_MS = 5 * 60 * 1000;

/** The keys are missing, malformed or refused: nothing a retry would fix. */
class OnlineBillingUnavailableError extends AppError {
  constructor() {
    super('ONLINE_BILLING_UNAVAILABLE', 'Online payment is not available right now.', 503);
    this.name = 'OnlineBillingUnavailableError';
  }
}

let cached = null; // { account, token, expiresAt }
let pending = null; // the in-flight token request

// A token is good only for the client it was issued to.
const accountOf = (config) => `${config.tokenUrl} ${config.clientId}`;
const secretsOf = (config, token) => [config.clientSecret, config.clientId, config.hashKey, token];

function messageOf(json, text) {
  if (json && typeof json === 'object') {
    const message = json.message !== undefined ? json.message : json.error_description || json.error;
    return typeof message === 'string' ? message : JSON.stringify(message || json);
  }
  return typeof text === 'string' ? text : '';
}

async function send(opts) {
  try {
    return await gatewayHttp.request(opts);
  } catch (err) {
    throw new GatewayError(`Fawaterak could not be reached (${err.message}).`);
  }
}

async function requestToken(config) {
  const res = await send({
    method: 'POST',
    url: config.tokenUrl,
    body: { grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret },
  });
  const json = res.json || {};
  if (res.status === 400 || res.status === 401) {
    logger.error(
      `Fawaterak refused the OAuth client credentials (HTTP ${res.status}): check FAWATERAK_CLIENT_ID and ` +
        'FAWATERAK_CLIENT_SECRET, and that they belong to FAWATERAK_ENV.'
    );
    throw new OnlineBillingUnavailableError();
  }
  if (!res.ok || typeof json.access_token !== 'string' || !json.access_token) {
    throw new GatewayError(`Fawaterak's token endpoint answered HTTP ${res.status} without a token.`);
  }
  const expiresIn = Number(json.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn * 1000, MAX_TOKEN_TTL_MS) : FALLBACK_TOKEN_TTL_MS;
  return { account: accountOf(config), token: json.access_token, expiresAt: Date.now() + Math.max(0, ttl - TOKEN_MARGIN_MS) };
}

async function accessToken(config) {
  if (cached && cached.account === accountOf(config) && cached.expiresAt > Date.now()) return cached.token;
  if (!pending) {
    pending = requestToken(config)
      .then((fresh) => {
        cached = fresh;
        return fresh.token;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** An API call with the Bearer token, retried once with a new token on a 401. */
async function authorized(config, opts) {
  const call = async () => {
    const token = await accessToken(config);
    const res = await send({ ...opts, headers: { authorization: `Bearer ${token}` } });
    return { res, token };
  };
  let { res, token } = await call();
  if (res.status === 401) {
    if (cached && cached.token === token) cached = null;
    ({ res, token } = await call());
  }
  if (res.status === 401) {
    logger.error('Fawaterak refused a fresh access token for this OAuth client (HTTP 401).');
    throw new OnlineBillingUnavailableError();
  }
  return { res, token };
}

/**
 * Creates a hosted checkout link for `body` (createTransaction without
 * payment_method_id). Resolves { intentKey, url, expiresIn }.
 * GatewayRejectedError: Fawaterak refused it (definite, nothing was created).
 * GatewayError: no definite answer.
 */
async function createTransaction(config, body) {
  const { res, token } = await authorized(config, {
    method: 'POST',
    url: `${config.baseUrl}/api/v3/createTransaction`,
    body,
    timeoutMs: gatewayHttp.WRITE_TIMEOUT_MS,
  });
  const json = res.json || {};
  const message = sanitizeGatewayMessage(messageOf(json, res.text), secretsOf(config, token));
  if (res.status === 422 || (res.ok && json.status === 'error')) {
    throw new GatewayRejectedError(`Fawaterak refused the transaction: ${message || `HTTP ${res.status}`}`);
  }
  if (!res.ok) throw new GatewayError(`Fawaterak createTransaction answered HTTP ${res.status}: ${message}`);
  const data = json.data || {};
  let url = null;
  try {
    url = new URL(data.url);
  } catch (err) {
    url = null;
  }
  if (json.status !== 'success' || typeof data.intent_key !== 'string' || !data.intent_key || !url || url.protocol !== 'https:') {
    throw new GatewayError('Fawaterak createTransaction answered without an intent key and an https checkout URL.');
  }
  const expiresIn = Number(data.expires_in);
  return { intentKey: data.intent_key, url: url.toString(), expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null };
}

/**
 * The transaction behind `intentKey` as Fawaterak has it now:
 * { found: false } when it does not know the key (422), otherwise
 * { found: true, data } with `data` as the reference's TransactionDetail.
 * `retry` only from the sweep and the status read — never on a webhook,
 * which should be answered promptly.
 */
async function getTransactionData(config, intentKey, { retry = false } = {}) {
  const { res, token } = await authorized(config, {
    method: 'POST',
    url: `${config.baseUrl}/api/v3/getTransactionData`,
    body: { intent_key: intentKey },
    retry,
  });
  const json = res.json || {};
  if (res.status === 422) return { found: false };
  if (!res.ok || json.status !== 'success' || !json.data || typeof json.data !== 'object') {
    const message = sanitizeGatewayMessage(messageOf(json, res.text), secretsOf(config, token));
    throw new GatewayError(`Fawaterak getTransactionData answered HTTP ${res.status}: ${message}`);
  }
  return { found: true, data: json.data };
}

/** Tests only: forget the cached token. */
function resetTokenCache() {
  cached = null;
  pending = null;
}

module.exports = { OnlineBillingUnavailableError, createTransaction, getTransactionData, resetTokenCache };
