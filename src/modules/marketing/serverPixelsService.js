'use strict';

const db = require('../../db/models');
const secretBox = require('../../core/utils/secretBox');
const { recordAudit } = require('../audit/auditService');

/**
 * "server_pixels" — one workspace_integrations row per workspace covering
 * all four ad platforms at once (they're managed together on one settings
 * screen, unlike paymob/bosta which are each their own provider row).
 *
 * Public pixel/measurement ids stay exactly where they already are —
 * workspaces.settings.tracking_pixels (see workspaceService.js,
 * workspaceValidation.js) — this integration's `secretsSealed` only ever
 * holds the platforms' CAPI access tokens, and `config` holds nothing secret
 * (there is nothing non-secret worth caching here: which platforms are
 * "configured" is just "does this secret field have a value", derived at
 * read time from the sealed blob, not duplicated into `config`).
 *
 * No verify-before-save call is made here, unlike Paymob/Bosta: none of the
 * four platforms offers a safe, side-effect-free way to check a CAPI token
 * before storing it. Meta's /debug_token needs an app access token we never
 * collect from the merchant (these are System User tokens, not app
 * credentials); TikTok/Snapchat/Google have no read-only equivalent at all.
 * Actually sending a real test event on connect would risk polluting the
 * merchant's live ad account with a fake conversion. So a token is accepted
 * as given, and the first real send simply surfaces an auth error into
 * `lastError` — exactly what the task calls out as the acceptable fallback.
 */
const PROVIDER = 'server_pixels';

const SECRET_FIELDS = ['metaAccessToken', 'metaTestEventCode', 'tiktokAccessToken', 'snapchatAccessToken', 'googleApiSecret'];

async function getIntegration(workspaceId, { transaction } = {}) {
  return db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER }, transaction });
}

function secretsOf(integration) {
  if (!integration) return {};
  return JSON.parse(secretBox.open(integration.secretsSealed) || '{}');
}

/** What the dashboard sees: never the raw tokens, only whether each is set. */
function integrationView(integration) {
  if (!integration) {
    return {
      connected: false,
      platforms: {
        meta: { configured: false },
        tiktok: { configured: false },
        snapchat: { configured: false },
        google: { configured: false },
      },
    };
  }
  const s = secretsOf(integration);
  return {
    connected: integration.status === 'connected',
    status: integration.status,
    platforms: {
      meta: { configured: Boolean(s.metaAccessToken), accessTokenMask: secretBox.mask(s.metaAccessToken), testEventCodeSet: Boolean(s.metaTestEventCode) },
      tiktok: { configured: Boolean(s.tiktokAccessToken), accessTokenMask: secretBox.mask(s.tiktokAccessToken) },
      snapchat: { configured: Boolean(s.snapchatAccessToken), accessTokenMask: secretBox.mask(s.snapchatAccessToken) },
      google: { configured: Boolean(s.googleApiSecret), apiSecretMask: secretBox.mask(s.googleApiSecret) },
    },
    lastVerifiedAt: integration.lastVerifiedAt,
    lastError: integration.lastError,
  };
}

/**
 * Saves/replaces tokens. A field left `undefined` in `patch` keeps whatever
 * was already stored (so the merchant can configure one platform at a time
 * across separate saves); a field sent as `''` clears it back to "not
 * configured". The validation schema requires the body to touch at least one
 * field, but every field clearing out is a legal end state (an empty,
 * "connected" row with nothing configured yet) — callers only ever act on a
 * platform once both its public id and its secret are present, see
 * pixelEvents.js.
 */
async function connect(workspaceId, patch, req) {
  const existing = await getIntegration(workspaceId);
  const previous = secretsOf(existing);

  const next = { ...previous };
  for (const field of SECRET_FIELDS) {
    if (!(field in patch)) continue;
    next[field] = patch[field] === '' ? undefined : patch[field];
  }
  // Drop undefined keys so an empty JSON blob (not a blob full of `"key":null`)
  // is what ends up sealed once every platform has been cleared.
  Object.keys(next).forEach((k) => next[k] === undefined && delete next[k]);

  const secretsSealed = secretBox.seal(JSON.stringify(next));
  const fields = { workspaceId, provider: PROVIDER, status: 'connected', config: {}, secretsSealed, lastVerifiedAt: new Date(), lastError: null };
  const integration = existing ? await existing.update(fields) : await db.WorkspaceIntegration.create(fields);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'integration.server_pixels.connect',
    entityType: 'WorkspaceIntegration',
    entityId: integration.id,
    after: { platforms: Object.keys(next).filter((k) => next[k]) },
    req,
  });
  return integration;
}

async function disconnect(workspaceId, req) {
  const integration = await getIntegration(workspaceId);
  if (!integration) return { disconnected: false };
  await integration.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'integration.server_pixels.disconnect', entityType: 'WorkspaceIntegration', entityId: integration.id, req });
  return { disconnected: true };
}

/**
 * Records the outcome of a real send attempt (called from pixelEvents.js,
 * never from the request/response cycle above). Kept intentionally coarse —
 * one shared lastVerifiedAt/lastError across all four platforms, prefixed
 * with the platform name, rather than four new columns; see pixelEvents.js
 * for why a dedicated audit table wasn't a good fit either.
 */
async function recordSendResult(workspaceId, platform, result) {
  const integration = await getIntegration(workspaceId);
  if (!integration) return;
  if (result.ok) {
    // Only clear an error this same platform previously left — a Meta
    // success running right after a TikTok failure in the same order's batch
    // must never wipe out the TikTok error that still needs surfacing.
    const keepError = integration.lastError && !integration.lastError.startsWith(`${platform}:`);
    await integration.update({ lastVerifiedAt: new Date(), lastError: keepError ? integration.lastError : null });
  } else {
    await integration.update({ lastError: `${platform}: ${String(result.error).slice(0, 490)}` });
  }
}

module.exports = { PROVIDER, SECRET_FIELDS, getIntegration, secretsOf, integrationView, connect, disconnect, recordSendResult };
