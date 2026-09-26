'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const serverPixelsService = require('./serverPixelsService');
const metaCapi = require('./pixelProviders/metaCapi');
const tiktokCapi = require('./pixelProviders/tiktokCapi');
const snapchatCapi = require('./pixelProviders/snapchatCapi');
const googleMp = require('./pixelProviders/googleMp');

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
 * is silently skipped, exactly like every other integration in this
 * codebase (see paymobService/bostaService: no integration -> no call).
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

function eventSourceUrlFor(workspace, orderId) {
  if (!workspace || !workspace.slug) return null;
  return `https://${workspace.slug}.${env.platformRootDomain}/thank-you?order=${orderId}`;
}

/** Google Ads ("AW-"/"GT-") ids are a different product (OAuth-based
 * Enhanced Conversions) this client does not implement — see
 * pixelProviders/googleMp.js. Only a GA4 measurement id ("G-") is sent. */
function isGa4MeasurementId(id) {
  return typeof id === 'string' && /^G-/i.test(id);
}

async function run(workspaceId, trigger, orderId) {
  if (trigger !== 'order.created') return [];

  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) return [];
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug', 'settings'] });
  const integration = await serverPixelsService.getIntegration(workspaceId);
  if (!integration) return [];

  const secrets = serverPixelsService.secretsOf(integration);
  const pixels = (workspace && workspace.settings && workspace.settings.tracking_pixels) || {};
  // The order's own id, used as the event id on every platform, so a
  // matching browser-side eventID (see apps/storefront/src/lib/track.ts) and
  // this server-side event dedup into one conversion instead of two.
  const eventId = order.id;
  const eventSourceUrl = eventSourceUrlFor(workspace, order.id);

  // clientIp/userAgent are part of each provider's sendPurchase signature
  // (Meta/TikTok/Snapchat all accept them for Advanced-Matching-style
  // quality signals) but are not available here: this runs fire-and-forget
  // from transaction.afterCommit with no HTTP request in scope, and the
  // Order model does not persist the placing request's IP/user-agent
  // anywhere. Left out rather than guessed — hashed email/phone from
  // order.contactSnapshot is still sent, which is what each platform
  // actually matches the conversion on.

  const jobs = [];
  if (pixels.meta && secrets.metaAccessToken) {
    jobs.push(['meta', () => metaCapi.sendPurchase({ pixelId: pixels.meta, secrets, order, eventId, eventSourceUrl })]);
  }
  if (pixels.tiktok && secrets.tiktokAccessToken) {
    jobs.push(['tiktok', () => tiktokCapi.sendPurchase({ pixelCode: pixels.tiktok, secrets, order, eventId, eventSourceUrl })]);
  }
  if (pixels.snapchat && secrets.snapchatAccessToken) {
    jobs.push(['snapchat', () => snapchatCapi.sendPurchase({ pixelId: pixels.snapchat, secrets, order, eventId, eventSourceUrl })]);
  }
  if (pixels.google_tag && isGa4MeasurementId(pixels.google_tag) && secrets.googleApiSecret) {
    jobs.push(['google', () => googleMp.sendPurchase({ measurementId: pixels.google_tag, secrets, order, eventId })]);
  }

  const results = [];
  for (const [platform, send] of jobs) {
    try {
      const result = await send();
      logger.info(`[pixelEvents] ${platform} purchase sent`, { workspaceId, orderId, platform, eventId });
      await serverPixelsService.recordSendResult(workspaceId, platform, { ok: true });
      results.push({ platform, ok: true, result });
    } catch (err) {
      logger.error(`[pixelEvents] ${platform} purchase failed: ${err.message}`, { workspaceId, orderId, platform, eventId, code: err.code });
      await serverPixelsService.recordSendResult(workspaceId, platform, { ok: false, error: err.message });
      results.push({ platform, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Fire-and-forget, exactly like automationEngine.emit — never blocks or
 * fails order creation. Call from `transaction.afterCommit` so the order
 * (and, on a webhook-driven confirm, nothing here) already exists.
 */
function emit(workspaceId, trigger, orderId) {
  run(workspaceId, trigger, orderId).catch((err) => logger.error(`[pixelEvents] ${trigger} for order ${orderId} failed: ${err.message}`));
}

module.exports = { emit, run };
