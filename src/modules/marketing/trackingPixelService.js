'use strict';

const db = require('../../db/models');
const secretBox = require('../../core/utils/secretBox');
const { NotFoundError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { eventsFor } = require('./browserPixelEvents');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');

/**
 * Tracking pixels (SPEC §13.1, §13.5): the store's ad and analytics tags.
 *
 * A store may have several pixels per platform. Each has a scope — the whole
 * store, some funnels or some products — and, on the platforms with a
 * server-side API, its own Conversions-API token and test event code.
 *
 *   platform   browser tag                server side (pixelProviders/*)
 *   meta       Meta Pixel                 Conversions API
 *   tiktok     TikTok Pixel               Events API
 *   snapchat   Snap Pixel                 Conversions API
 *   google     gtag (GA4 "G-", Ads "AW-") GA4 Measurement Protocol (G- only)
 *   gtm        Tag Manager container      —
 *   clarity    Microsoft Clarity project  —
 * With STORE_FEATURES extra_pixels:
 *   pinterest  Pinterest Tag              Conversions API (per ad account: config.adAccountId)
 *   x          X pixel                    Conversions API (OAuth 1.0a: the token is
 *                                        "consumerKey:consumerSecret:accessToken:accessTokenSecret";
 *                                        a conversion per X event id in config.eventIds)
 *   reddit     Reddit Pixel               Conversions API
 *   microsoft  UET tag                    UET Conversions API
 *   taboola, outbrain, kwai   browser tag only (event names in browserPixelEvents.js)
 * Their server APIs stay in sandbox (built and logged only) until *_CAPI_MODE=live.
 *
 * The public half (platform, pixelId, scope) is served to the storefront by
 * publicPixels(); the token never leaves the server.
 */

const PLATFORMS = Object.freeze({
  meta: { idPattern: /^\d{5,20}$/, capi: true, testEventCode: true },
  tiktok: { idPattern: /^[A-Z0-9]{10,30}$/, capi: true, testEventCode: false },
  snapchat: { idPattern: /^[a-f0-9-]{20,40}$/i, capi: true, testEventCode: false },
  google: { idPattern: /^(G|AW|GT)-[A-Z0-9]{4,20}$/, capi: true, testEventCode: false },
  gtm: { idPattern: /^GTM-[A-Z0-9]{4,12}$/, capi: false, testEventCode: false },
  clarity: { idPattern: /^[a-z0-9]{6,20}$/, capi: false, testEventCode: false },
  // STORE_FEATURES extra_pixels. The Pinterest Tag id: digits, about 13 of them; its Conversions API
  // is per ad account (config.adAccountId; pixelProviders/pinterestCapi.js).
  pinterest: { idPattern: /^\d{10,16}$/, capi: true, testEventCode: true },
  // X pixel id, Taboola account id, Outbrain marketer id, Kwai pixel id, Reddit pixel (t2_/a2_), Microsoft Ads UET tag id.
  x: { idPattern: /^[a-z0-9]{4,12}$/i, capi: true, testEventCode: false },
  taboola: { idPattern: /^\d{4,10}$/, capi: false, testEventCode: false },
  outbrain: { idPattern: /^[a-f0-9]{20,40}$/i, capi: false, testEventCode: false },
  kwai: { idPattern: /^\d{10,25}$/, capi: false, testEventCode: false },
  // Reddit's test switch is the pixel's test event code being set (sent as test_mode).
  reddit: { idPattern: /^(t2|a2)_[a-z0-9]{4,20}$/i, capi: true, testEventCode: true },
  microsoft: { idPattern: /^\d{5,12}$/, capi: true, testEventCode: false },
});
const PLATFORM_NAMES = Object.keys(PLATFORMS);
// The platforms behind STORE_FEATURES extra_pixels: off, they are not offered, loaded or sent to.
const EXTRA_PLATFORMS = ['pinterest', 'x', 'taboola', 'outbrain', 'kwai', 'reddit', 'microsoft'];
const platformOn = (platform) => !EXTRA_PLATFORMS.includes(platform) || storeFeatureOn('extra_pixels');

/** Whether a platform's server events leave the server: 'live', 'sandbox' (built and logged only) or null (no server API). */
const SANDBOXED = { pinterest: 'pinterestCapi', reddit: 'redditCapi', microsoft: 'microsoftCapi', x: 'xCapi' };
function serverModeOf(platform) {
  if (!PLATFORMS[platform] || !PLATFORMS[platform].capi) return null;
  return SANDBOXED[platform] ? require(`./pixelProviders/${SANDBOXED[platform]}`).mode() : 'live';
}
const SCOPE_TYPES = ['all', 'funnels', 'products'];
const MAX_PIXELS = 30;

/** GA4's Measurement Protocol only takes a "G-" id; Ads ("AW-") has no server API here. */
const supportsCapi = (platform, pixelId) =>
  PLATFORMS[platform].capi && (platform !== 'google' || /^G-/i.test(pixelId));

function serialize(pixel) {
  const token = pixel.capiTokenSealed ? secretBox.open(pixel.capiTokenSealed) : null;
  return {
    id: pixel.id,
    platform: pixel.platform,
    pixelId: pixel.pixelId,
    label: pixel.label,
    capiEnabled: pixel.capiEnabled,
    capiSupported: supportsCapi(pixel.platform, pixel.pixelId),
    ...(EXTRA_PLATFORMS.includes(pixel.platform) ? { serverMode: supportsCapi(pixel.platform, pixel.pixelId) ? serverModeOf(pixel.platform) : null } : {}),
    capiTokenSet: Boolean(token),
    capiTokenMask: secretBox.mask(token),
    testEventCode: pixel.testEventCode,
    scope: { type: pixel.scopeType, ids: pixel.scopeIds || [] },
    config: pixel.config || {},
    isActive: pixel.isActive,
    lastSentAt: pixel.lastSentAt,
    lastError: pixel.lastError,
    createdAt: pixel.createdAt,
    updatedAt: pixel.updatedAt,
  };
}

const fieldError = (field, message) => new ValidationError([{ field, message }], 'Invalid body');

function assertPixelId(platform, pixelId) {
  if (!PLATFORMS[platform].idPattern.test(pixelId)) {
    throw fieldError('pixelId', `"${pixelId}" is not a valid ${platform} ID`);
  }
}

/** Scope ids must be this store's own funnels/products. */
async function cleanScope(workspaceId, scope, transaction) {
  if (!scope || scope.type === 'all') return { scopeType: 'all', scopeIds: [] };
  const ids = [...new Set(scope.ids || [])];
  if (ids.length === 0) throw fieldError('scope.ids', 'Choose at least one item for this scope');
  const Model = scope.type === 'funnels' ? db.Funnel : db.Product;
  const found = await Model.count({ where: { workspaceId, id: ids }, transaction });
  if (found !== ids.length) throw fieldError('scope.ids', 'Some of the chosen items do not belong to this store');
  return { scopeType: scope.type, scopeIds: ids };
}

async function list(workspaceId) {
  const pixels = await db.TrackingPixel.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  return {
    pixels: pixels.map(serialize),
    platforms: PLATFORM_NAMES.filter(platformOn).map((name) => ({ name, capi: PLATFORMS[name].capi, testEventCode: PLATFORMS[name].testEventCode, ...(EXTRA_PLATFORMS.includes(name) ? { serverMode: serverModeOf(name) } : {}) })),
    limit: MAX_PIXELS,
  };
}

/** Pinterest's Conversions API is per ad account: its id is needed to turn it on. */
function assertAdAccount(platform, capiEnabled, config) {
  if (platform === 'pinterest' && capiEnabled && !(config && config.adAccountId)) {
    throw fieldError('config.adAccountId', 'The Pinterest ad account id is needed to turn the Conversions API on');
  }
}

/** X signs with OAuth 1.0a: its token is the four keys (pixelProviders/xCapi.js). */
function assertTokenShape(platform, token) {
  if (platform === 'x' && token && !require('./pixelProviders/xCapi').parseToken(token)) {
    throw fieldError('capiToken', 'For X, paste the four keys as consumerKey:consumerSecret:accessToken:accessTokenSecret');
  }
}

async function create(workspaceId, body, req) {
  if (!platformOn(body.platform)) throw fieldError('platform', `"${body.platform}" is not available`);
  assertPixelId(body.platform, body.pixelId);
  return db.sequelize.transaction(async (transaction) => {
    if ((await db.TrackingPixel.count({ where: { workspaceId }, transaction })) >= MAX_PIXELS) {
      throw new ConflictError(`A store can have at most ${MAX_PIXELS} pixels`, 'TRACKING_PIXEL_LIMIT');
    }
    if (await db.TrackingPixel.findOne({ where: { workspaceId, platform: body.platform, pixelId: body.pixelId }, transaction })) {
      throw new ConflictError('This pixel is already added to the store', 'TRACKING_PIXEL_EXISTS');
    }
    const capable = supportsCapi(body.platform, body.pixelId);
    const scope = await cleanScope(workspaceId, body.scope, transaction);
    if (body.capiEnabled && capable && !body.capiToken) throw fieldError('capiToken', 'A token is needed to turn the Conversions API on');
    assertTokenShape(body.platform, body.capiToken);
    assertAdAccount(body.platform, body.capiEnabled, body.config);
    const pixel = await db.TrackingPixel.create(
      {
        workspaceId,
        platform: body.platform,
        pixelId: body.pixelId,
        label: body.label || null,
        capiEnabled: Boolean(body.capiEnabled && capable),
        capiTokenSealed: capable && body.capiToken ? secretBox.seal(body.capiToken) : null,
        testEventCode: PLATFORMS[body.platform].testEventCode ? body.testEventCode || null : null,
        ...scope,
        config: body.config || {},
        isActive: body.isActive !== false,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'tracking_pixel.create',
      entityType: 'TrackingPixel',
      entityId: pixel.id,
      req,
      after: { platform: pixel.platform, pixelId: pixel.pixelId, capiEnabled: pixel.capiEnabled, scope: body.scope || { type: 'all' } },
      transaction,
    });
    return serialize(pixel);
  });
}

async function update(workspaceId, pixelId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const pixel = await db.TrackingPixel.findOne({ where: { id: pixelId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!pixel) throw new NotFoundError('TrackingPixel');
    const before = { pixelId: pixel.pixelId, capiEnabled: pixel.capiEnabled, isActive: pixel.isActive, scopeType: pixel.scopeType };
    const patch = {};

    if (body.pixelId !== undefined && body.pixelId !== pixel.pixelId) {
      assertPixelId(pixel.platform, body.pixelId);
      const clash = await db.TrackingPixel.findOne({ where: { workspaceId, platform: pixel.platform, pixelId: body.pixelId }, transaction });
      if (clash) throw new ConflictError('This pixel is already added to the store', 'TRACKING_PIXEL_EXISTS');
      patch.pixelId = body.pixelId;
    }
    if (body.label !== undefined) patch.label = body.label || null;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.config !== undefined) patch.config = body.config || {};
    if (body.scope !== undefined) Object.assign(patch, await cleanScope(workspaceId, body.scope, transaction));
    if (body.testEventCode !== undefined && PLATFORMS[pixel.platform].testEventCode) patch.testEventCode = body.testEventCode || null;
    // capiToken: undefined keeps the stored one, '' removes it.
    if (body.capiToken) assertTokenShape(pixel.platform, body.capiToken);
    if (body.capiToken !== undefined) patch.capiTokenSealed = body.capiToken ? secretBox.seal(body.capiToken) : null;

    const capable = supportsCapi(pixel.platform, patch.pixelId || pixel.pixelId);
    const hasToken = patch.capiTokenSealed !== undefined ? Boolean(patch.capiTokenSealed) : Boolean(pixel.capiTokenSealed);
    const wantsCapi = body.capiEnabled !== undefined ? body.capiEnabled : pixel.capiEnabled;
    if (body.capiEnabled && capable && !hasToken) throw fieldError('capiToken', 'A token is needed to turn the Conversions API on');
    assertAdAccount(pixel.platform, wantsCapi, patch.config !== undefined ? patch.config : pixel.config);
    patch.capiEnabled = Boolean(wantsCapi && capable && hasToken);

    await pixel.update(patch, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'tracking_pixel.update',
      entityType: 'TrackingPixel',
      entityId: pixel.id,
      req,
      before,
      after: { pixelId: pixel.pixelId, capiEnabled: pixel.capiEnabled, isActive: pixel.isActive, scopeType: pixel.scopeType, tokenChanged: body.capiToken !== undefined },
      transaction,
    });
    return serialize(pixel);
  });
}

async function remove(workspaceId, pixelId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const pixel = await db.TrackingPixel.findOne({ where: { id: pixelId, workspaceId }, transaction });
    if (!pixel) throw new NotFoundError('TrackingPixel');
    await pixel.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'tracking_pixel.delete',
      entityType: 'TrackingPixel',
      entityId: pixel.id,
      req,
      before: { platform: pixel.platform, pixelId: pixel.pixelId },
      transaction,
    });
    return { deleted: true };
  });
}

/** What the storefront may know: the public IDs and where each applies. */
async function publicPixels(workspaceId) {
  const pixels = await db.TrackingPixel.findAll({
    where: { workspaceId, isActive: true },
    attributes: ['id', 'platform', 'pixelId', 'scopeType', 'scopeIds', 'config'],
    order: [['createdAt', 'ASC']],
  });
  return pixels.filter((p) => platformOn(p.platform)).map((p) => ({
    platform: p.platform,
    pixelId: p.pixelId,
    scope: { type: p.scopeType, ids: p.scopeIds || [] },
    ...(p.platform === 'google' && p.config && p.config.adsConversionLabel ? { adsConversionLabel: p.config.adsConversionLabel } : {}),
    // The browser-only platforms' event names (browserPixelEvents.js).
    ...(eventsFor(p.platform, p.config) ? { events: eventsFor(p.platform, p.config) } : {}),
  }));
}

/** True when a pixel's scope covers an order (its funnel, or any of its products). */
function scopeCovers(pixel, { funnelId = null, productIds = [] }) {
  if (pixel.scopeType === 'all') return true;
  const ids = pixel.scopeIds || [];
  if (pixel.scopeType === 'funnels') return Boolean(funnelId) && ids.includes(funnelId);
  if (pixel.scopeType === 'products') return productIds.some((id) => ids.includes(id));
  return false;
}

/** The pixels a server-side event for this order goes to, each with its opened token. */
async function serverPixelsFor(workspaceId, context) {
  const pixels = await db.TrackingPixel.findAll({ where: { workspaceId, isActive: true, capiEnabled: true }, order: [['createdAt', 'ASC']] });
  return pixels
    .filter((p) => platformOn(p.platform) && p.capiTokenSealed && supportsCapi(p.platform, p.pixelId) && scopeCovers(p, context))
    .map((p) => ({ pixel: p, token: secretBox.open(p.capiTokenSealed) }));
}

/** One pixel as a send target ({ pixel, token }), or null when it has no usable server API. */
function serverTargetOf(pixel) {
  if (!platformOn(pixel.platform) || !pixel.capiEnabled || !pixel.capiTokenSealed || !supportsCapi(pixel.platform, pixel.pixelId)) return null;
  return { pixel, token: secretBox.open(pixel.capiTokenSealed) };
}

async function recordSendResult(pixel, { ok, error }) {
  await pixel.update(ok ? { lastSentAt: new Date(), lastError: null } : { lastError: String(error).slice(0, 500) });
}

module.exports = {
  PLATFORMS,
  PLATFORM_NAMES,
  SCOPE_TYPES,
  MAX_PIXELS,
  supportsCapi,
  list,
  create,
  update,
  remove,
  publicPixels,
  scopeCovers,
  serverPixelsFor,
  serverTargetOf,
  recordSendResult,
};
