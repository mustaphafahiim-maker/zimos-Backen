'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const trackingPixelService = require('./trackingPixelService');
const pixelEventLog = require('./pixelEventLog');
const purchaseTiming = require('./purchaseTiming');
const metaCapi = require('./pixelProviders/metaCapi');
const tiktokCapi = require('./pixelProviders/tiktokCapi');
const snapchatCapi = require('./pixelProviders/snapchatCapi');
const googleMp = require('./pixelProviders/googleMp');
const pixelMatching = require('./pixelMatching');

/**
 * Server-side ad-platform conversion events ("Meta CAPI", TikTok Events API,
 * Snapchat CAPI, GA4 Measurement Protocol) for a Purchase-equivalent
 * conversion, so ad platforms see the order even when the shopper's browser
 * blocked the client-side pixel or closed the tab before it fired.
 *
 * Unlike automationEngine.js, these are NOT merchant-configured rules — they
 * fire unconditionally for every order, subject only to which platforms are
 * actually configured (a public pixel/measurement id in
 * workspaces.settings.tracking_pixels AND a matching secret in this
 * workspace's "server_pixels" integration). A platform missing either half
 * is silently skipped: no integration -> no call.
 *
 * Only 'order.created' is handled. That is the one moment that corresponds
 * to a Purchase-equivalent conversion for this storefront: checkout is a
 * single COD-or-paid-online step (see orders/orderService.js#createOrder)
 * and the client-side pixel's own `trackPurchaseOnce` fires at that same
 * moment (thank-you page, right after order creation) — see
 * apps/storefront/src/lib/track.ts. order.confirmed/order.rejected/
 * order.cancelled/order.shipped/etc. describe what happens to an order
 * *after* the sale, not the sale itself, and the storefront pixel never
 * fires again for any of them, so mirroring pixelEvents onto those trigger
 * points would double- (or wrongly-) count revenue in the ad platforms.
 */

// Logging only — no dedicated table. AutomationRun exists to drive the
// automations UI (per-rule run history, retry stats); there is no rule here
// to attach a run to. NotificationLog's `channel` is a fixed ENUM
// ('email'|'sms'|'whatsapp') that doesn't fit ad platforms without a schema
// migration, and recordAudit is for merchant-visible audit trails, not
// third-party delivery telemetry. A structured logger.info/error line per
// platform per order (see below) plus the shared lastVerifiedAt/lastError on
// the server_pixels integration row (serverPixelsService#recordSendResult)
// is enough to debug a merchant's "my TikTok didn't get the conversion"
// report without inventing a new audit table for four log lines a day.

async function eventSourceUrlFor(workspace, orderId) {
  if (!workspace || !workspace.slug) return null;
  // The store's canonical address: the domain its ads point to (domains/primaryHost.js).
  return `${await require('../domains/primaryHost').storeOriginOf(workspace)}/thank-you?order=${orderId}`;
}

/** Google Ads ("AW-"/"GT-") ids are a different product (OAuth-based
 * Enhanced Conversions) this client does not implement — see
 * pixelProviders/googleMp.js. Only a GA4 measurement id ("G-") is sent. */
function isGa4MeasurementId(id) {
  return typeof id === 'string' && /^G-/i.test(id);
}

async function run(workspaceId, trigger, orderId) {
  if (!purchaseTiming.TRIGGERS.includes(trigger)) return [];

  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.OrderItem, as: 'items', attributes: ['productId', 'variantId', 'skuSnapshot', 'quantity', 'unitPriceAmount'], required: false }],
  });
  if (!order) return [];
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug', 'settings'] });
  // The merchant chooses the moment an order counts as a Purchase (SPEC
  // §13.3, purchaseTiming.js); a test order never does. It is reported once.
  if (order.isTest || !purchaseTiming.isDue(purchaseTiming.timingOf(workspace && workspace.settings), trigger, order)) return [];
  if (!(await purchaseTiming.claim(order.id))) return [];
  // Since migration 152 the pixels are rows of tracking_pixels, each with its
  // own token and scope (trackingPixelService.js): the order goes to every
  // active CAPI pixel whose scope covers its funnel or one of its products.
  const targets = await trackingPixelService.serverPixelsFor(workspaceId, {
    funnelId: order.funnelId,
    productIds: [...new Set((order.items || []).map((i) => i.productId).filter(Boolean))],
  });
  if (targets.length === 0) {
    await purchaseTiming.release(order.id);
    return [];
  }
  // The order's own id, used as the event id on every platform, so a
  // matching browser-side eventID (see apps/storefront/src/lib/track.ts) and
  // this server-side event dedup into one conversion instead of two.
  const eventId = order.id;
  const eventSourceUrl = await eventSourceUrlFor(workspace, order.id);

  // Who bought and what, for the platform to match the order to the ad
  // click (pixelMatching.js): the IP and browser kept at checkout, the
  // platforms' browser ids, hashed name / city / country, the lines.
  const matching = pixelMatching.matchingFor(order);
  const seen = { clientIp: matching.clientIp, userAgent: matching.userAgent, matching };
  const touches = order.attribution || {};
  const clickOf = (key) => (touches.last && touches.last[key]) || (touches.first && touches.first[key]) || undefined;

  // The providers keep their original signature (a `secrets` blob with one
  // named key per platform); each pixel's own token is handed to them in that
  // shape. Several pixels of one platform get the same event id.
  const SENDERS = {
    meta: ({ pixel, token }) =>
      metaCapi.sendPurchase({ pixelId: pixel.pixelId, secrets: { metaAccessToken: token, metaTestEventCode: pixel.testEventCode || undefined }, order, eventId, eventSourceUrl, ...seen, fbp: matching.fbp, fbc: matching.fbc }),
    tiktok: ({ pixel, token }) => tiktokCapi.sendPurchase({ pixelCode: pixel.pixelId, secrets: { tiktokAccessToken: token }, order, eventId, eventSourceUrl, ...seen }),
    snapchat: ({ pixel, token }) => snapchatCapi.sendPurchase({ pixelId: pixel.pixelId, secrets: { snapchatAccessToken: token }, order, eventId, eventSourceUrl, ...seen }),
    google: ({ pixel, token }) =>
      isGa4MeasurementId(pixel.pixelId) ? googleMp.sendPurchase({ measurementId: pixel.pixelId, secrets: { googleApiSecret: token }, order, eventId, matching }) : null,
    // STORE_FEATURES extra_pixels; sandbox until their *_CAPI_MODE=live. Click ids come from the order's touch when it has them.
    pinterest: ({ pixel, token }) =>
      require('./pixelProviders/pinterestCapi').sendPurchase({ adAccountId: (pixel.config || {}).adAccountId, secrets: { pinterestAccessToken: token }, order, eventId, eventSourceUrl, ...seen, eventName: 'purchase', test: Boolean(pixel.testEventCode) }),
    reddit: ({ pixel, token }) =>
      require('./pixelProviders/redditCapi').sendPurchase({ accountId: pixel.pixelId, token, order, eventId, ...seen, clickId: clickOf('rdt_cid'), eventName: 'purchase', test: Boolean(pixel.testEventCode) }),
    microsoft: ({ pixel, token }) =>
      require('./pixelProviders/microsoftCapi').sendPurchase({ tagId: pixel.pixelId, token, order, eventId, eventSourceUrl, ...seen, msclkid: clickOf('msclkid'), eventName: 'purchase' }),
    x: ({ pixel, token }) =>
      require('./pixelProviders/xCapi').sendPurchase({ pixelId: pixel.pixelId, token, xEventId: ((pixel.config || {}).eventIds || {}).purchase || null, order, eventId, matching, twclid: clickOf('twclid') }),
  };

  const results = [];
  for (const target of targets) {
    const { pixel } = target;
    const platform = pixel.platform;
    if (!SENDERS[platform]) continue;
    try {
      const result = await SENDERS[platform](target);
      logger.info(`[pixelEvents] ${platform} purchase sent`, { workspaceId, orderId, platform, pixelId: pixel.pixelId, eventId });
      await trackingPixelService.recordSendResult(pixel, { ok: true });
      await pixelEventLog.record({ pixel, eventName: 'purchase', eventId, orderId, ok: true });
      results.push({ platform, pixelId: pixel.pixelId, ok: true, result });
    } catch (err) {
      logger.error(`[pixelEvents] ${platform} purchase failed: ${err.message}`, { workspaceId, orderId, platform, pixelId: pixel.pixelId, eventId, code: err.code });
      await trackingPixelService.recordSendResult(pixel, { ok: false, error: err.message });
      await pixelEventLog.record({ pixel, eventName: 'purchase', eventId, orderId, ok: false, error: err.message });
      results.push({ platform, pixelId: pixel.pixelId, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Fire-and-forget, exactly like automationEngine.emit — never blocks or
 * fails order creation. Call from `transaction.afterCommit` so the order
 * (and, on a webhook-driven confirm, nothing here) already exists. Under
 * test the work is handed back so the afterCommit hook waits for it, for
 * the same reason as automationEngine.emit.
 */
function emit(workspaceId, trigger, orderId) {
  const work = run(workspaceId, trigger, orderId).catch((err) => logger.error(`[pixelEvents] ${trigger} for order ${orderId} failed: ${err.message}`));
  return env.isTest ? work : undefined;
}

module.exports = { emit, run };
