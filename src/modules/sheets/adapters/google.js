'use strict';

const crypto = require('crypto');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const { AppError } = require('../../../core/errors/AppError');

/**
 * The real Google Sheets adapter (README.md has the contract): OAuth 2.0
 * authorization-code flow with PKCE for the scope `drive.file` (only files the
 * app creates, or the merchant picks), then Sheets API v4 and Drive v3.
 *
 * Configured by GOOGLE_SHEETS_CLIENT_ID / GOOGLE_SHEETS_CLIENT_SECRET /
 * GOOGLE_SHEETS_REDIRECT_URI; until all three are set the adapter answers
 * SHEETS_UNAVAILABLE (adapters/index.js).
 *
 * Credentials are { accessToken, refreshToken, expiresAt, scope }. The access
 * token is refreshed when it is about to expire and once on a 401; the new one
 * is written back sealed through `credentials.onRefresh` (credentialStore.js),
 * and a refresh refused for good (`invalid_grant`) calls `credentials.onRevoked`
 * so the store is asked to connect again. Tokens never go into a log line or
 * an error message.
 */

const name = 'google';
const sandbox = false;
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const TIMEOUT_MS = 20000;
const EXPIRY_MARGIN_MS = 60 * 1000;
// A 429 asking to wait this long or less is waited for here (at most twice); a longer one goes back to the outbox.
const MAX_INLINE_WAIT_MS = 10 * 1000;
const MAX_QUOTA_RETRIES = 2;

const config = () => ({
  clientId: (process.env.GOOGLE_SHEETS_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GOOGLE_SHEETS_CLIENT_SECRET || '').trim(),
  redirectUri: (process.env.GOOGLE_SHEETS_REDIRECT_URI || '').trim(),
});

function isConfigured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri);
}

// Google's hosts. The overrides exist for local stand-ins and are ignored in production.
const host = (key, fallback) => String((!env.isProduction && process.env[key]) || fallback).replace(/\/+$/, '');
const AUTH_URL = () => `${host('GOOGLE_SHEETS_AUTH_BASE', 'https://accounts.google.com')}/o/oauth2/v2/auth`;
const OAUTH2 = () => host('GOOGLE_SHEETS_OAUTH2_BASE', 'https://oauth2.googleapis.com');
const SHEETS = () => `${host('GOOGLE_SHEETS_API_BASE', 'https://sheets.googleapis.com')}/v4/spreadsheets`;
const DRIVE = () => `${host('GOOGLE_SHEETS_DRIVE_BASE', 'https://www.googleapis.com')}/drive/v3`;

const fail = (code, message, status, extra) => Object.assign(new AppError(code, message, status), extra || {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- PKCE --

/**
 * The PKCE verifier is derived from the signed state (HMAC with the client
 * secret), so nothing is stored between the redirect and the code exchange:
 * whoever holds the code but not the state, or not the secret, cannot redeem it.
 */
const verifierOf = (state) => crypto.createHmac('sha256', config().clientSecret).update(`sheets-pkce:${state}`).digest('base64url');
const challengeOf = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

// ------------------------------------------------------------------- HTTP --

async function send(method, url, { token, json, form, timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw fail('SHEETS_UNREACHABLE', `Google did not answer (${err.name === 'TimeoutError' ? 'timeout' : 'network error'})`, 502);
  }
  let body = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

/** Seconds to wait from a Retry-After header (seconds or an HTTP date); null when absent. */
function retryAfterMs(header) {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** What Google said went wrong: { status, reasons, message } from either the Sheets or the Drive error shape. */
function googleError(body) {
  const e = (body && body.error) || {};
  const reasons = new Set();
  if (typeof e === 'string') reasons.add(e);
  if (e.status) reasons.add(e.status);
  (e.errors || []).forEach((x) => x && x.reason && reasons.add(x.reason));
  (e.details || []).forEach((x) => x && x.reason && reasons.add(x.reason));
  const message = typeof e === 'object' && e.message ? String(e.message).slice(0, 300) : '';
  return { reasons, message };
}

const QUOTA_REASONS = ['RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'];
const isQuota = (status, reasons) => status === 429 || (status === 403 && QUOTA_REASONS.some((r) => reasons.has(r)));

/** A Google error as the README's codes. 401s and quota are handled before this. */
function mapError(status, body, { opening } = {}) {
  const { reasons, message } = googleError(body);
  if (status === 403 && (reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || reasons.has('insufficientPermissions'))) {
    return fail('SHEETS_ACCESS_REVOKED', 'The Google account no longer lets ZIMOS write to Google Sheets — connect it again', 403, { accountRevoked: true });
  }
  if (status === 403 && (reasons.has('SERVICE_DISABLED') || reasons.has('accessNotConfigured'))) {
    logger.error('[sheets] the Google Cloud project has the Sheets or Drive API turned off', { message });
    return fail('SHEETS_UNAVAILABLE', 'Google Sheets is not available right now', 503);
  }
  if (status === 403 && reasons.has('storageQuotaExceeded')) {
    return fail('SHEETS_REJECTED', 'The Google Drive of this account is full', 422);
  }
  if (status === 403) {
    return fail('SHEETS_PERMISSION_DENIED', 'This Google account cannot edit that spreadsheet any more', 403);
  }
  if (status === 404) {
    return fail(
      'SHEETS_NOT_FOUND',
      opening
        ? 'That spreadsheet was not found. ZIMOS can only reuse spreadsheets it created for this Google account'
        : 'The spreadsheet does not exist or was deleted',
      404
    );
  }
  // A tab that was renamed or deleted: Google cannot read the range.
  if (status === 400 && /Unable to parse range/i.test(message)) {
    return fail('SHEETS_NOT_FOUND', 'The sheet tab was renamed or deleted', 404);
  }
  if (status === 400) return fail('SHEETS_REJECTED', `Google Sheets refused the change: ${message || 'bad request'}`, 422);
  return fail('SHEETS_UNREACHABLE', `Google Sheets answered ${status}`, 502);
}

// ------------------------------------------------------------ the tokens --

async function revokedForGood(credentials, reason) {
  if (typeof credentials.onRevoked === 'function') {
    try {
      await credentials.onRevoked(reason);
    } catch (err) {
      logger.warn('[sheets] could not mark the Google account as revoked', { message: err.message });
    }
  }
  return fail('SHEETS_ACCESS_REVOKED', 'Access to Google Sheets was removed — connect the Google account again', 403, { accountRevoked: true });
}

/** A new access token from the refresh token; written back sealed by the caller's hook. */
async function refresh(credentials) {
  if (!credentials.refreshToken) throw await revokedForGood(credentials, 'no refresh token');
  const c = config();
  const res = await send('POST', `${OAUTH2()}/token`, {
    form: { grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: c.clientId, client_secret: c.clientSecret },
  });
  const error = res.body && res.body.error;
  if (res.status === 400 && error === 'invalid_grant') throw await revokedForGood(credentials, 'invalid_grant');
  if (res.status === 401 || error === 'invalid_client' || error === 'unauthorized_client') {
    // The platform's client id/secret, not the merchant: the owner has to fix it.
    logger.error('[sheets] Google refused the OAuth client (GOOGLE_SHEETS_CLIENT_ID / SECRET)', { error });
    throw fail('SHEETS_UNAVAILABLE', 'Google Sheets is not available right now', 503);
  }
  if (res.status !== 200 || !res.body || !res.body.access_token) throw fail('SHEETS_UNREACHABLE', `Google answered ${res.status} to a token refresh`, 502);
  credentials.accessToken = res.body.access_token;
  credentials.expiresAt = Date.now() + Number(res.body.expires_in || 3600) * 1000;
  if (res.body.refresh_token) credentials.refreshToken = res.body.refresh_token;
  if (res.body.scope) credentials.scope = res.body.scope;
  if (typeof credentials.onRefresh === 'function') {
    try {
      await credentials.onRefresh({ accessToken: credentials.accessToken, refreshToken: credentials.refreshToken, expiresAt: credentials.expiresAt, scope: credentials.scope });
    } catch (err) {
      // The token in hand still works; the next run refreshes again.
      logger.warn('[sheets] could not keep the refreshed Google token', { message: err.message });
    }
  }
}

/**
 * One Google API call with the merchant's token: refreshed ahead of expiry,
 * and once more on a 401; a 429 (or a quota 403) waits Retry-After when it is
 * short, else becomes SHEETS_UNREACHABLE for the outbox to retry later.
 */
async function api(credentials, method, url, { json, opening } = {}) {
  if (!credentials || typeof credentials !== 'object') throw fail('SHEETS_NOT_CONNECTED', 'Connect a Google account first', 409);
  if (!credentials.accessToken || !credentials.expiresAt || Number(credentials.expiresAt) - EXPIRY_MARGIN_MS < Date.now()) await refresh(credentials);
  let refreshed = false;
  let quotaTries = 0;
  for (;;) {
    const res = await send(method, url, { token: credentials.accessToken, json });
    if (res.status >= 200 && res.status < 300) return res.body || {};
    const { reasons } = googleError(res.body);
    if (res.status === 401) {
      if (refreshed) throw await revokedForGood(credentials, 'unauthenticated after refresh');
      refreshed = true;
      await refresh(credentials);
      continue;
    }
    if (isQuota(res.status, reasons)) {
      const waitMs = retryAfterMs(res.retryAfter);
      const wait = waitMs === null ? 1000 * 2 ** quotaTries : waitMs;
      if (quotaTries < MAX_QUOTA_RETRIES && wait <= MAX_INLINE_WAIT_MS) {
        quotaTries += 1;
        await sleep(wait);
        continue;
      }
      throw fail('SHEETS_UNREACHABLE', 'Google Sheets asked to slow down (quota) — trying again shortly', 429, {
        retryAfterSeconds: waitMs === null ? null : Math.ceil(waitMs / 1000),
      });
    }
    const err = mapError(res.status, res.body, { opening });
    if (err.accountRevoked) throw await revokedForGood(credentials, 'scope missing');
    throw err;
  }
}

// --------------------------------------------------------------- helpers --

/** A tab name in A1 notation: always quoted, quotes doubled. */
const tab = (sheetName) => `'${String(sheetName).replace(/'/g, "''")}'`;
const rangeUrl = (spreadsheetId, range) => `${SHEETS()}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'number' || typeof v === 'boolean' ? v : String(v));
const cells = (rows) => rows.map((row) => (Array.isArray(row) ? row.map(cell) : []));

/** An id from a pasted Google Sheets link, or the id itself. */
function idOf(spreadsheetId) {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(String(spreadsheetId || ''));
  return m ? m[1] : String(spreadsheetId || '').trim();
}

/** The first row number of an A1 range such as `'Orders'!A12:P13` → 12. */
function firstRowOf(updatedRange) {
  const m = /!\$?[A-Z]*\$?(\d+)/.exec(String(updatedRange || ''));
  return m ? Number(m[1]) : null;
}

/** The email in the id_token Google's token endpoint just handed us over TLS (OpenID Connect allows reading it unverified then). */
function emailOf(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload && payload.email ? String(payload.email).toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- OAuth --

/** Google's consent screen. The redirect is always GOOGLE_SHEETS_REDIRECT_URI (Google allows only registered ones). */
function authorizeUrl({ state }) {
  const c = config();
  const url = new URL(AUTH_URL());
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeOf(verifierOf(state)));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function exchangeCode(code, { state } = {}) {
  if (!state) throw fail('SHEETS_AUTH_FAILED', 'The Google sign-in expired — try again', 400);
  const c = config();
  const res = await send('POST', `${OAUTH2()}/token`, {
    form: {
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: c.redirectUri,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code_verifier: verifierOf(state),
    },
  });
  const error = res.body && res.body.error;
  if (res.status === 400 && (error === 'invalid_grant' || error === 'invalid_request')) {
    throw fail('SHEETS_AUTH_FAILED', 'That Google sign-in was already used or expired — try again', 400);
  }
  if (res.status === 401 || error === 'invalid_client' || error === 'redirect_uri_mismatch' || error === 'unauthorized_client') {
    logger.error('[sheets] Google refused the OAuth client on code exchange', { error });
    throw fail('SHEETS_UNAVAILABLE', 'Google Sheets is not available right now', 503);
  }
  if (res.status !== 200 || !res.body || !res.body.access_token) throw fail('SHEETS_UNREACHABLE', `Google answered ${res.status}`, 502);
  const t = res.body;
  const credentials = { accessToken: t.access_token, refreshToken: t.refresh_token || null, expiresAt: Date.now() + Number(t.expires_in || 3600) * 1000, scope: t.scope || '' };
  const granted = String(t.scope || '').split(/\s+/);
  // Google's consent screen lets the merchant untick the Drive box; without it nothing can be written.
  if (!granted.includes(DRIVE_FILE_SCOPE)) {
    await revoke(credentials);
    throw fail('SHEETS_SCOPE_MISSING', 'Allow ZIMOS to "see, edit, create and delete the Google Drive files you use with this app" — tick it and try again', 400);
  }
  if (!credentials.refreshToken) {
    await revoke(credentials);
    throw fail('SHEETS_AUTH_FAILED', 'Google did not grant offline access — try again', 400);
  }
  let account = emailOf(t.id_token);
  if (!account) {
    // No id_token (should not happen with the openid scope): ask Drive who this is.
    const about = await api(credentials, 'GET', `${DRIVE()}/about?fields=user(emailAddress)`).catch(() => null);
    account = (about && about.user && about.user.emailAddress) || null;
  }
  return { account, credentials };
}

/** Disconnect: Google forgets the grant (the refresh token, and so every access token from it). Best effort. */
async function revoke(credentials) {
  const token = credentials && (credentials.refreshToken || credentials.accessToken);
  if (!token) return { revoked: false };
  try {
    const res = await send('POST', `${OAUTH2()}/revoke`, { form: { token } });
    // 400 invalid_token: already revoked or expired, which is what we wanted.
    return { revoked: res.status === 200 || res.status === 400 };
  } catch (err) {
    logger.warn('[sheets] Google token revoke failed', { code: err.code });
    return { revoked: false };
  }
}

// --------------------------------------------------------- spreadsheets --

async function createSpreadsheet(credentials, { title }) {
  const sheetName = 'Sheet1';
  const created = await api(credentials, 'POST', `${SHEETS()}?fields=spreadsheetId,spreadsheetUrl`, {
    json: { properties: { title: String(title || 'ZIMOS').slice(0, 200) }, sheets: [{ properties: { title: sheetName, gridProperties: { frozenRowCount: 1 } } }] },
  });
  return { spreadsheetId: created.spreadsheetId, sheetName, url: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit` };
}

/** A spreadsheet the app may write to (by id or link); checks it is a live spreadsheet this account can edit, and adds the tab when missing. */
async function openSpreadsheet(credentials, { spreadsheetId, sheetName }) {
  const id = idOf(spreadsheetId);
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw fail('SHEETS_NOT_FOUND', 'That is not a Google Sheets link or id', 404);
  const file = await api(credentials, 'GET', `${DRIVE()}/files/${encodeURIComponent(id)}?fields=id,mimeType,trashed,capabilities(canEdit)&supportsAllDrives=true`, { opening: true });
  if (file.trashed) throw fail('SHEETS_NOT_FOUND', 'That spreadsheet is in the Google Drive trash', 404);
  if (file.mimeType && file.mimeType !== SPREADSHEET_MIME) throw fail('SHEETS_NOT_FOUND', 'That file is not a Google Sheets spreadsheet', 404);
  if (file.capabilities && file.capabilities.canEdit === false) throw fail('SHEETS_PERMISSION_DENIED', 'This Google account can only view that spreadsheet', 403);
  const meta = await api(credentials, 'GET', `${SHEETS()}/${encodeURIComponent(id)}?fields=spreadsheetId,spreadsheetUrl,sheets.properties(sheetId,title)`, { opening: true });
  const titles = (meta.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
  const wanted = sheetName ? String(sheetName).trim() : titles[0] || 'Sheet1';
  if (!titles.includes(wanted)) {
    await api(credentials, 'POST', `${SHEETS()}/${encodeURIComponent(id)}:batchUpdate`, {
      json: { requests: [{ addSheet: { properties: { title: wanted, gridProperties: { frozenRowCount: 1 } } } }] },
    });
  }
  return { spreadsheetId: meta.spreadsheetId || id, sheetName: wanted, url: meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit` };
}

/** Row 1, the titles: cleared first so a shorter header leaves no stale titles. */
async function setHeader(credentials, { spreadsheetId, sheetName, header }) {
  await api(credentials, 'POST', `${rangeUrl(spreadsheetId, `${tab(sheetName)}!1:1`)}:clear`, { json: {} });
  await api(credentials, 'PUT', `${rangeUrl(spreadsheetId, `${tab(sheetName)}!A1`)}?valueInputOption=RAW`, {
    json: { range: `${tab(sheetName)}!A1`, majorDimension: 'ROWS', values: cells([header]) },
  });
}

/** After the last row. RAW: a customer's name never runs as a formula. */
async function appendRows(credentials, { spreadsheetId, sheetName, rows }) {
  const out = await api(
    credentials,
    'POST',
    `${rangeUrl(spreadsheetId, `${tab(sheetName)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`,
    { json: { range: `${tab(sheetName)}!A1`, majorDimension: 'ROWS', values: cells(rows) } }
  );
  const firstRow = firstRowOf(out.updates && out.updates.updatedRange);
  if (!firstRow) throw fail('SHEETS_UNREACHABLE', 'Google Sheets did not say where the rows went', 502);
  return { firstRow };
}

async function updateRows(credentials, { spreadsheetId, sheetName, firstRow, rows }) {
  const range = `${tab(sheetName)}!A${Number(firstRow)}`;
  await api(credentials, 'PUT', `${rangeUrl(spreadsheetId, range)}?valueInputOption=RAW`, { json: { range, majorDimension: 'ROWS', values: cells(rows) } });
}

/** Every row of the tab as text, for the dashboard's preview. */
async function readRows(credentials, { spreadsheetId, sheetName }) {
  const out = await api(credentials, 'GET', `${rangeUrl(spreadsheetId, tab(sheetName))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  return (out.values || []).map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))));
}

module.exports = {
  name,
  sandbox,
  isConfigured,
  authorizeUrl,
  exchangeCode,
  revoke,
  createSpreadsheet,
  openSpreadsheet,
  setHeader,
  appendRows,
  updateRows,
  readRows,
};
