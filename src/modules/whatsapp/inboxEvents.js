'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');

/**
 * Live updates for the inbox (SPEC §14.3) over Server-Sent Events.
 *
 * Two sources feed a connected dashboard:
 *
 *  - publish(): the webhook and the send path call it in this process, so a
 *    new message reaches the screen at once;
 *  - a light poll per connection (one MAX(updated_at) query every few
 *    seconds), so it still works when the change happened in another process
 *    — a separate worker, a second API instance — with no Redis to relay it.
 *
 * The stream only says *that* something changed and where; the dashboard
 * then reads the conversation through the normal, permission-checked API.
 *
 * EventSource cannot send an Authorization header, so the stream is opened
 * with a short-lived ticket the dashboard gets from an authenticated call.
 */

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const TICKET_TTL_MS = 60 * 1000;
const POLL_MS = 5000;
const HEARTBEAT_MS = 25000;

const sign = (payload) => crypto.createHmac('sha256', env.jwt.accessSecret).update(`inbox-stream:${payload}`).digest('base64url');

/** A one-minute pass to open the stream as this teammate in this store. */
// `sid`: the session the ticket was asked under; the stream ends with it (core/security/sessionGate.js).
function issueTicket(workspaceId, userId, sid = '') {
  const payload = `${workspaceId}.${userId}.${Date.now() + TICKET_TTL_MS}.${sid || ''}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** { workspaceId, userId } or null. */
function readTicket(ticket) {
  const [encoded, signature] = String(ticket || '').split('.');
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [workspaceId, userId, expires, sid] = payload.split('.');
  if (!workspaceId || !userId || Number(expires) < Date.now()) return null;
  return { workspaceId, userId, sid: sid || null };
}

/** Something changed in a conversation of this store. */
function publish(workspaceId, event) {
  emitter.emit(workspaceId, { type: 'change', at: new Date().toISOString(), ...event });
}

async function lastChange(workspaceId) {
  const [row] = await db.sequelize.query('SELECT MAX(updated_at) AS at FROM whatsapp_conversations WHERE workspace_id = :workspaceId', {
    replacements: { workspaceId },
    type: QueryTypes.SELECT,
  });
  return row && row.at ? new Date(row.at).getTime() : 0;
}

/** Holds the response open and writes events until the browser goes away. */
async function stream(workspaceId, req, res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx and friends: do not buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  write({ type: 'ready' });

  let seen = await lastChange(workspaceId).catch(() => 0);
  let lastPublished = 0;
  const onEvent = (event) => {
    lastPublished = Date.now();
    write(event);
  };
  emitter.on(workspaceId, onEvent);

  const poll = setInterval(async () => {
    try {
      const now = await lastChange(workspaceId);
      // Skip what publish() already told this connection about.
      if (now > seen && Date.now() - lastPublished > POLL_MS) write({ type: 'change', at: new Date(now).toISOString() });
      seen = Math.max(seen, now);
    } catch {
      /* the next tick tries again */
    }
  }, POLL_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(poll);
    clearInterval(heartbeat);
    emitter.off(workspaceId, onEvent);
    res.end();
  });
}

module.exports = { issueTicket, readTicket, publish, stream, TICKET_TTL_MS };
