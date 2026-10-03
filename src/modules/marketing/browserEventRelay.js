'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const queue = require('../../core/queue');
const logger = require('../../core/utils/logger');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const trackingPixelService = require('./trackingPixelService');
const pixelEventLog = require('./pixelEventLog');
const orderAttribution = require('./orderAttribution');
const browserEvents = require('./pixelProviders/browserEvents');

/**
 * Relays storefront events to the ad platforms' server APIs (SPEC §13.2).
 *
 * POST /store/:ws/events (modules/analytics) records the batch for the
 * store's own analytics and then calls relay(): every conversion event in it
 * becomes one job on the `pixels` queue, and the job sends the event to each
 * Conversions-API pixel whose scope covers it — with the event id the browser
 * pixel used, so the platform counts browser + server once.
 *
 * Page views are not relayed (one request per page per pixel would dwarf
 * everything else and the browser pixel already reports them), and Purchase
 * has its own path driven by the stored order (pixelEvents.js).
 */

const JOB = 'pixels.browser_event';
const RELAYED = new Set(['view_content', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'lead']);

const str = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const uuidList = (value) =>
  Array.isArray(value) ? value.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50) : [];

/** A store with no CAPI pixel queues nothing; the answer is remembered for a minute per process. */
const hasServerPixels = (() => {
  const cache = new Map();
  return async (workspaceId) => {
    const hit = cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = (await db.TrackingPixel.count({ where: { workspaceId, isActive: true, capiEnabled: true } })) > 0;
    cache.set(workspaceId, { value, until: Date.now() + 60 * 1000 });
    if (cache.size > 5000) cache.clear();
    return value;
  };
})();

/**
 * Called by the events endpoint after the batch is stored. Never throws and
 * never delays the 202: a relay problem is logged, the analytics stay intact.
 */
async function relay(workspaceId, body, { clientIp, userAgent } = {}) {
  // A purchase event in the batch carries the shopper's first/last touch onto its order (§13.4).
  await orderAttribution.capture(workspaceId, body);
  try {
    const events = (body.events || []).filter((e) => RELAYED.has(e.name) && e.eventId);
    if (events.length === 0 || !(await hasServerPixels(workspaceId))) return 0;
    const browser = body.pixel || {};
    for (const e of events) {
      const meta = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
      await queue.add(
        'pixels',
        JOB,
        {
          name: e.name,
          eventId: e.eventId,
          occurredAt: e.occurredAt || new Date().toISOString(),
          url: str(e.url, 2000),
          valueMinor: Number.isInteger(e.revenueAmount) ? e.revenueAmount : undefined,
          currency: e.currency || str(meta.currency, 3),
          contentIds: Array.isArray(meta.contentIds) ? meta.contentIds.filter((x) => typeof x === 'string').slice(0, 50) : [],
          numItems: Number.isInteger(meta.numItems) ? meta.numItems : undefined,
          funnelId: e.funnelId || null,
          productIds: uuidList(browser.productIds),
          clientIp,
          userAgent: str(userAgent, 500),
          visitorId: body.visitorId,
          browser: {
            fbp: str(browser.fbp, 200),
            fbc: str(browser.fbc, 500),
            ttp: str(browser.ttp, 200),
            ttclid: str(browser.ttclid, 500),
            scCid: str(browser.scCid, 500),
          },
        },
        { workspaceId, dedupeKey: `bev:${workspaceId}:${e.eventId}` }
      );
    }
    return events.length;
  } catch (err) {
    logger.error(`[browserEventRelay] could not queue events for ${workspaceId}: ${err.message}`);
    return 0;
  }
}

async function sendTo(target, event, { isTest = false } = {}) {
  const { pixel } = target;
  try {
    await browserEvents.send(target, event);
    await trackingPixelService.recordSendResult(pixel, { ok: true });
    await pixelEventLog.record({ pixel, eventName: event.name, eventId: event.eventId, ok: true, isTest });
    return { ok: true };
  } catch (err) {
    await trackingPixelService.recordSendResult(pixel, { ok: false, error: err.message });
    await pixelEventLog.record({ pixel, eventName: event.name, eventId: event.eventId, ok: false, error: err.message, isTest });
    return { ok: false, error: err.message, unreachable: err.statusCode === 502 };
  }
}

/** The queue job. Retried only when a platform could not be reached at all. */
async function process(job) {
  const event = job.payload;
  const targets = await trackingPixelService.serverPixelsFor(job.workspaceId, { funnelId: event.funnelId, productIds: event.productIds || [] });
  let unreachable = 0;
  for (const target of targets) {
    const result = await sendTo(target, event);
    if (result.unreachable) unreachable += 1;
  }
  // Every platform down (network): let the queue try again. A platform that
  // answered with an error is logged and not retried — the log row is the report.
  if (targets.length > 0 && unreachable === targets.length) throw new Error('No ad platform could be reached');
}

/**
 * "Send test event" (SPEC §13.5): a page view — never a conversion — sent to
 * one pixel right now, so the merchant sees whether the token works. With a
 * Meta test event code it lands under Test events.
 */
async function sendTest(workspaceId, trackingPixelId, req) {
  const pixel = await db.TrackingPixel.findOne({ where: { id: trackingPixelId, workspaceId } });
  if (!pixel) throw new NotFoundError('TrackingPixel');
  const target = await trackingPixelService.serverTargetOf(pixel);
  if (!target) {
    throw new AppError('TRACKING_PIXEL_NO_SERVER_API', 'Turn the Conversions API on and save a token for this pixel first', 422);
  }
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['slug'] });
  const env = require('../../config/env');
  const event = {
    name: 'page_view',
    eventId: `test-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    url: workspace && workspace.slug ? `https://${workspace.slug}.${env.platformRootDomain}/` : undefined,
    clientIp: req.ip,
    userAgent: str(req.headers['user-agent'], 500),
    visitorId: `test-${workspaceId}`,
    browser: {},
  };
  const result = await sendTo(target, event, { isTest: true });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'tracking_pixel.test_event',
    entityType: 'TrackingPixel',
    entityId: pixel.id,
    req,
    after: { ok: result.ok },
  });
  return { ok: result.ok, error: result.error || null, eventId: event.eventId, usedTestCode: Boolean(pixel.platform === 'meta' && pixel.testEventCode) };
}

module.exports = { JOB, RELAYED, relay, process, sendTest };
