'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');

const HOUR_MS = 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = HOUR_MS;
const PAST_TOLERANCE_MS = 7 * 24 * HOUR_MS;
const METADATA_MAX_BYTES = 2048;

/** Client metadata lands in a JSONB column on every hit; anything over 2KB is dropped, the event kept. */
function boundedMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.stringify(value).length <= METADATA_MAX_BYTES ? value : {};
  } catch {
    return {};
  }
}

/** Coarse device class from the User-Agent; good enough for a "sessions by device" tile. */
function deviceFromUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'unknown';
  if (/iPad|Tablet|PlayBook|Silk/i.test(s)) return 'tablet';
  if (/Mobi|Android|iPhone|IEMobile/i.test(s)) return 'mobile';
  return 'desktop';
}

/** A client-supplied timestamp is only trusted inside a sane window; otherwise "now". */
function resolveOccurredAt(occurredAt, now) {
  if (!occurredAt) return now;
  const t = new Date(occurredAt);
  if (Number.isNaN(t.getTime())) return now;
  if (t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return now;
  if (t.getTime() < now.getTime() - PAST_TOLERANCE_MS) return now;
  return t;
}

/**
 * Stores a batch of storefront events for one visitor session. The client is
 * never trusted for revenue: a `purchase` that names an order is kept only
 * when that order belongs to the workspace, and its amount is the order's
 * stored total. Repeated dedupeIds are dropped by the unique partial index
 * (ignoreDuplicates), so the browser can safely retry a batch.
 *
 * Returns the number of events accepted (written or deduped).
 */
async function ingest(workspaceId, body, { userAgent } = {}) {
  const now = new Date();
  const device = deviceFromUserAgent(userAgent);
  const attribution = body.attribution || {};

  const distinct = (pick) => [...new Set(body.events.map(pick).filter(Boolean))];
  const orderIds = distinct((e) => (e.name === 'purchase' ? e.orderId : null));
  const websiteIds = distinct((e) => e.websiteId);
  const funnelIds = distinct((e) => e.funnelId);

  // website/funnel/order columns are foreign keys: a reference that isn't this
  // workspace's is nulled (or, for a purchase, the event is dropped) rather
  // than letting Postgres reject the whole batch.
  const [orderRows, websiteRows, funnelRows] = await Promise.all([
    orderIds.length ? db.Order.findAll({ where: { workspaceId, id: { [Op.in]: orderIds } }, attributes: ['id', 'totalAmount'], raw: true }) : [],
    websiteIds.length ? db.Website.findAll({ where: { workspaceId, id: { [Op.in]: websiteIds } }, attributes: ['id'], raw: true }) : [],
    funnelIds.length ? db.Funnel.findAll({ where: { workspaceId, id: { [Op.in]: funnelIds } }, attributes: ['id'], raw: true }) : [],
  ]);
  const orders = new Map(orderRows.map((o) => [o.id, o]));
  const websites = new Set(websiteRows.map((w) => w.id));
  const funnels = new Set(funnelRows.map((f) => f.id));

  const rows = [];
  for (const e of body.events) {
    let orderId = null;
    let revenueAmount = e.revenueAmount === undefined ? null : e.revenueAmount;
    if (e.name === 'purchase' && e.orderId) {
      const order = orders.get(e.orderId);
      if (!order) continue; // not this workspace's order (or doesn't exist): drop
      orderId = order.id;
      revenueAmount = Number(order.totalAmount);
    }
    rows.push({
      workspaceId,
      websiteId: e.websiteId && websites.has(e.websiteId) ? e.websiteId : null,
      funnelId: e.funnelId && funnels.has(e.funnelId) ? e.funnelId : null,
      visitorId: body.visitorId,
      sessionId: body.sessionId,
      dedupeId: e.dedupeId || null,
      eventName: e.name,
      source: attribution.source || null,
      medium: attribution.medium || null,
      campaign: attribution.campaign || null,
      referrer: attribution.referrer || null,
      landingPage: attribution.landingPage || null,
      clickIds: attribution.clickIds || null,
      orderId,
      revenueAmount,
      metadata: { ...boundedMetadata(e.metadata), device, ...(e.path ? { path: e.path } : {}) },
      createdAt: resolveOccurredAt(e.occurredAt, now),
    });
  }

  if (rows.length > 0) {
    await db.AnalyticsEvent.bulkCreate(rows, { ignoreDuplicates: true });
  }
  return { accepted: rows.length };
}

module.exports = { ingest, deviceFromUserAgent, resolveOccurredAt };
