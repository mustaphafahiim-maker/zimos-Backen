'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const { isValidPreviewToken: isValidPaymentsPreviewToken } = require('../../modules/payments/paymentMethodsService');

/**
 * Staff preview of a store that the public cannot see yet (a draft, see
 * workspaces/workspaceAccessService). Sent as the X-Store-Preview header, the
 * same header the payments preview token already uses, and in the same
 * stateless shape: `<payload>.<hmac>`, payload = base64url JSON
 * { w: workspaceId, exp: epoch seconds }, HMAC-SHA256 under the access-token
 * secret with its own purpose prefix — so it is never a login token, and it
 * never unlocks test-mode payment methods the way the payments one does.
 *
 * Either token lets its holder read a draft store's public pages; neither
 * lets anyone order from it (core/middleware/publicWorkspace).
 */

const TTL_SECONDS = 2 * 60 * 60;
const HEADER = 'x-store-preview';

function signature(payload) {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update(`store-preview:${payload}`).digest('base64url');
}

function issueStorePreviewToken(workspaceId) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, exp })).toString('base64url');
  return { token: `${payload}.${signature(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

function isValidStorePreviewToken(token, workspaceId) {
  if (typeof token !== 'string' || token.length > 500) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signature(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { w, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return w === workspaceId && typeof exp === 'number' && exp > Date.now() / 1000;
  } catch (err) {
    return false;
  }
}

/** A request carrying a staff preview token (store or payments) for this workspace. */
function isStorePreviewRequest(req, workspaceId) {
  const token = req.headers[HEADER];
  return isValidStorePreviewToken(token, workspaceId) || isValidPaymentsPreviewToken(token, workspaceId);
}

module.exports = { issueStorePreviewToken, isValidStorePreviewToken, isStorePreviewRequest, TTL_SECONDS };
