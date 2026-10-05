'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { AuthenticationError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const { countsAsSaleSql } = require('../orders/orderStage');
const web = require('./webAnalyticsService');
const { dayKey } = require('./analyticsService');

/**
 * Live view over Server-Sent Events (SPEC §15.2).
 *
 * The dashboard's realtime page used to ask every ten seconds. With the stream
 * it is told: each connection checks a cheap fingerprint (the newest event,
 * order and checkout of the store) every few seconds and, only when it moved,
 * sends a full snapshot — the same payload as GET /analytics/web/realtime plus
 * a `live` block (today's visitors, orders and sales; who is checking out now;
 * the latest purchases). Nothing is pushed while the store is quiet, except a
 * heartbeat that keeps proxies from closing the connection.
 *
 * EventSource cannot send an Authorization header, so the stream is opened
 * with a one-minute ticket from the authenticated POST …/stream-ticket — the
 * same scheme as the inbox stream (whatsapp/inboxEvents.js).
 */

const TICKET_TTL_MS = 60 * 1000;
const POLL_MS = 4000;
const HEARTBEAT_MS = 25000;
const MAX_STREAM_MS = 30 * 60 * 1000;

const sign = (payload) => crypto.createHmac('sha256', env.jwt.accessSecret).update(`realtime-stream:${payload}`).digest('base64url');

function issueTicket(workspaceId, userId, sid = '') {
  const payload = `${workspaceId}.${userId}.${Date.now() + TICKET_TTL_MS}.${sid || ''}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function readTicket(ticket) {
  const [encoded, signature] = String(ticket || '').split('.');
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [workspaceId, userId, expires, sid] = payload.split('.');
  if (!workspaceId || !userId || Number(expires) < Date.now()) return null;
  return { workspaceId, userId, sid: sid || null };
}

const select = (sql, replacements) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** Changes whenever anything the live view shows could have changed. */
async function fingerprint(workspaceId, funnelId) {
  const [row] = await select(
    `SELECT
       (SELECT max(created_at) FROM analytics_events WHERE workspace_id = :workspaceId AND created_at > now() - interval '35 minutes') AS event_at,
       (SELECT max(updated_at) FROM orders WHERE workspace_id = :workspaceId AND updated_at > now() - interval '1 day') AS order_at,
       (SELECT max(last_activity_at) FROM checkout_sessions WHERE workspace_id = :workspaceId AND last_activity_at > now() - interval '15 minutes') AS checkout_at`,
    { workspaceId }
  );
  // The minute is part of it so the per-minute chart keeps moving while visitors are active.
  const active = row.event_at ? Math.floor(Date.now() / 60000) : 0;
  return [row.event_at, row.order_at, row.checkout_at, active, funnelId || ''].map((v) => (v instanceof Date ? v.getTime() : v)).join('|');
}

/** Today's numbers and the live feed. "Today" is the store's own day. */
async function liveBlock(workspaceId, funnelId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  let tz = (workspace && workspace.timezone) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const replacements = { workspaceId, tz, today: dayKey(new Date(), tz), funnelId: funnelId || null };
  const orderFunnel = funnelId ? 'AND o.funnel_id = :funnelId' : '';
  const eventFunnel = funnelId ? 'AND e.funnel_id = :funnelId' : '';
  const [[visits], [orders], checkingOut, purchases] = await Promise.all([
    select(
      `SELECT count(DISTINCT coalesce(e.session_id, e.visitor_id)) AS visitors
         FROM analytics_events e
        WHERE e.workspace_id = :workspaceId AND e.created_at >= (:today::date AT TIME ZONE :tz) ${eventFunnel}`,
      replacements
    ),
    select(
      `SELECT count(*) AS orders, coalesce(sum(o.total_amount) FILTER (WHERE o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'), 0) AS sales
         FROM orders o
        WHERE o.workspace_id = :workspaceId AND o.created_at >= (:today::date AT TIME ZONE :tz) AND ${countsAsSaleSql('o')} ${orderFunnel}`,
      replacements
    ),
    select(
      `SELECT c.id, c.subtotal_amount, c.currency, c.source, c.last_activity_at, jsonb_array_length(c.items) AS items,
              c.contact_fields->>'governorate' AS governorate
         FROM checkout_sessions c
        WHERE c.workspace_id = :workspaceId AND c.status = 'in_progress' AND c.last_activity_at > now() - interval '10 minutes'
          ${funnelId ? "AND c.attribution->>'funnelId' = :funnelId" : ''}
        ORDER BY c.last_activity_at DESC LIMIT 20`,
      replacements
    ),
    select(
      `SELECT o.id, o.order_number, o.total_amount, o.currency, o.payment_method, o.created_at, o.funnel_id,
              o.shipping_address_snapshot->>'governorate' AS governorate
         FROM orders o
        WHERE o.workspace_id = :workspaceId AND o.created_at > now() - interval '24 hours' AND ${countsAsSaleSql('o')} ${orderFunnel}
        ORDER BY o.created_at DESC LIMIT 10`,
      replacements
    ),
  ]);
  return {
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
    today: { visitors: Number(visits.visitors), orders: Number(orders.orders), sales: Number(orders.sales) },
    checkingOut: checkingOut.map((c) => ({
      id: c.id,
      subtotalAmount: Number(c.subtotal_amount),
      currency: c.currency,
      items: Number(c.items),
      source: c.source,
      governorate: c.governorate || null,
      lastActivityAt: c.last_activity_at,
    })),
    purchases: purchases.map((o) => ({
      orderId: o.id,
      orderNumber: o.order_number,
      totalAmount: Number(o.total_amount),
      currency: o.currency,
      paymentMethod: o.payment_method,
      governorate: o.governorate || null,
      inFunnel: Boolean(o.funnel_id),
      createdAt: o.created_at,
    })),
  };
}

/** One full snapshot: the realtime payload plus the live block. Also served without the stream. */
async function snapshot(workspaceId, { funnelId } = {}) {
  const [realtime, live] = await Promise.all([web.getRealtime(workspaceId, {}), liveBlock(workspaceId, funnelId)]);
  // "Page views per minute" for the last ten minutes, as §15.2 asks.
  return { realtime: { ...realtime, series: (realtime.series || []).slice(-10) }, live, funnelId: funnelId || null };
}

async function stream(workspaceId, funnelId, req, res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  let closed = false;
  let seen = null;
  let busy = false;

  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const now = await fingerprint(workspaceId, funnelId);
      if (now !== seen) {
        seen = now;
        write({ type: 'snapshot', at: new Date().toISOString(), ...(await snapshot(workspaceId, { funnelId })) });
      }
    } catch {
      /* the next tick tries again */
    } finally {
      busy = false;
    }
  };

  await tick();
  const poll = setInterval(tick, POLL_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  // A stream is not kept for ever: the dashboard reconnects with a fresh ticket.
  const limit = setTimeout(() => res.end(), MAX_STREAM_MS);
  req.on('close', () => {
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    clearTimeout(limit);
    res.end();
  });
}

/**
 * The stream, mounted on its own at /api/v1/analytics-stream/:workspaceId —
 * outside /workspaces, whose routers demand a staff session on every path.
 */
const streamRouter = Router({ mergeParams: true });
streamRouter.get(
  '/:workspaceId',
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({ ticket: Joi.string().max(400).required(), funnelId: Joi.string().uuid().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const refused = () => new AuthenticationError('The stream ticket is missing or has expired');
    const ticket = readTicket(req.query.ticket);
    if (!ticket || ticket.workspaceId !== req.params.workspaceId) throw refused();
    const membership = await db.Membership.findOne({
      where: { workspaceId: ticket.workspaceId, userId: ticket.userId, status: 'active' },
      include: [{ model: db.Role, as: 'role' }],
    });
    // The same rule as tenantContext: the role's own list, or the owner's '*'.
    const permissions = membership && membership.role ? membership.role.permissions || [] : [];
    const allowed = permissions.includes('*') || permissions.includes(PERMISSIONS.ANALYTICS_VIEW);
    if (!allowed) throw refused();
    await stream(ticket.workspaceId, req.query.funnelId || null, req, res);
  })
);

module.exports = { issueTicket, readTicket, snapshot, stream, streamRouter, TICKET_TTL_MS };
