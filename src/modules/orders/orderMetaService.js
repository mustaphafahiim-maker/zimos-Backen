'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * The fields a merchant organises orders by (SPEC §4.2) — tags, seen, test,
 * archive — and the notes on an order. None of them touches the order's
 * state, stock or money, so they are changed here and not through
 * orderStateService.
 */

const SOURCES = ['store', 'funnel', 'manual', 'api', 'import', 'upsell'];
const NOTE_VISIBILITY = ['internal', 'public'];
const MAX_TAGS = 20;

/** Trimmed, de-duplicated (case-insensitively, first spelling wins), at most MAX_TAGS. */
function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags || []) {
    const tag = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

/**
 * Where a new order comes from, when its caller did not say: staff → manual,
 * an API key → api, a funnel id → funnel, anything else is the store.
 */
function sourceFor(req, { funnelId } = {}) {
  if (req && req.user) return 'manual';
  if (req && req.apiKey) return 'api';
  return funnelId ? 'funnel' : 'store';
}

/** A storefront order placed by staff previewing their own store (X-Store-Preview). */
function isTestRequest(req, workspaceId) {
  if (!req || req.user || !req.headers || !req.headers['x-store-preview']) return false;
  // Required here: storePreview loads the payments module, which loads orders.
  return require('../../core/security/storePreview').isStorePreviewRequest(req, workspaceId);
}

/**
 * PATCH /orders/:id/meta — any of { tags, isTest, isSeen, archived }.
 * Only what actually changes is written and audited.
 */
async function updateMeta(workspaceId, orderId, data, req, { transaction: outer = null } = {}) {
  const run = async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');

    const before = {};
    const updates = {};
    const set = (key, value, same) => {
      if (same) return;
      before[key] = order[key];
      updates[key] = value;
    };

    if (data.tags !== undefined) {
      const tags = normalizeTags(data.tags);
      set('tags', tags, JSON.stringify(tags) === JSON.stringify(order.tags || []));
    }
    if (data.addTags || data.removeTags) {
      const remove = new Set((data.removeTags || []).map((t) => String(t).trim().toLowerCase()));
      const current = (updates.tags || order.tags || []).filter((t) => !remove.has(t.toLowerCase()));
      const tags = normalizeTags([...current, ...(data.addTags || [])]);
      set('tags', tags, JSON.stringify(tags) === JSON.stringify(order.tags || []));
    }
    if (data.isTest !== undefined) set('isTest', data.isTest, data.isTest === order.isTest);
    if (data.isSeen !== undefined && data.isSeen !== order.isSeen) {
      set('isSeen', data.isSeen, false);
      updates.seenAt = data.isSeen ? new Date() : null;
    }
    if (data.archived !== undefined && data.archived !== Boolean(order.archivedAt)) {
      set('archivedAt', data.archived ? new Date() : null, false);
    }

    if (Object.keys(updates).length === 0) return order;
    // `silent`: marking an order seen must not move updated_at — the webhook
    // observer and the "last change" the merchant sees both read it.
    const onlySeen = Object.keys(updates).every((k) => k === 'isSeen' || k === 'seenAt');
    await order.update(updates, { transaction, silent: onlySeen });

    // Opening an order is not worth an audit row; everything else is.
    if (!onlySeen) {
      const after = {};
      for (const key of Object.keys(before)) after[key] = updates[key];
      await recordAudit({
        workspaceId,
        actorUserId: req && req.user ? req.user.id : null,
        action: updates.archivedAt !== undefined ? (updates.archivedAt ? 'order.archive' : 'order.unarchive') : 'order.meta_update',
        entityType: 'Order',
        entityId: order.id,
        before,
        after,
        req,
        transaction,
      });
    }
    return order;
  };
  const order = await (outer ? run(outer) : db.sequelize.transaction(run));
  return metaOf(order);
}

function metaOf(order) {
  return {
    id: order.id,
    source: order.source,
    tags: order.tags || [],
    isSeen: order.isSeen,
    seenAt: order.seenAt,
    isTest: order.isTest,
    archivedAt: order.archivedAt,
  };
}

/** Every tag in use in the workspace with how many orders carry it, most used first. */
async function listTags(workspaceId) {
  const rows = await db.sequelize.query(
    `SELECT tag, COUNT(*)::int AS count
       FROM orders o, unnest(o.tags) AS tag
      WHERE o.workspace_id = $workspaceId
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT 200`,
    { bind: { workspaceId }, type: QueryTypes.SELECT }
  );
  return rows;
}

// ------------------------------------------------------------------ notes

function serializeNote(note) {
  return {
    id: note.id,
    orderId: note.orderId,
    body: note.body,
    visibility: note.visibility,
    author: note.author ? { id: note.author.id, fullName: note.author.fullName } : null,
    createdAt: note.createdAt,
  };
}

async function assertOrder(workspaceId, orderId, transaction = null) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'], transaction });
  if (!order) throw new NotFoundError('Order');
}

/** Newest first. */
async function listNotes(workspaceId, orderId) {
  await assertOrder(workspaceId, orderId);
  const notes = await db.OrderNote.findAll({
    where: { workspaceId, orderId },
    include: [{ model: db.User, as: 'author', attributes: ['id', 'fullName'] }],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
  });
  return notes.map(serializeNote);
}

async function addNote(workspaceId, orderId, { body, visibility = 'internal' }, req) {
  return db.sequelize.transaction(async (transaction) => {
    await assertOrder(workspaceId, orderId, transaction);
    const note = await db.OrderNote.create(
      { workspaceId, orderId, body: body.trim(), visibility, authorUserId: req.user.id },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.note_add',
      entityType: 'Order',
      entityId: orderId,
      after: { noteId: note.id, visibility },
      req,
      transaction,
    });
    note.author = { id: req.user.id, fullName: req.user.fullName };
    return serializeNote(note);
  });
}

async function deleteNote(workspaceId, orderId, noteId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const note = await db.OrderNote.findOne({ where: { id: noteId, workspaceId, orderId }, transaction });
    if (!note) throw new NotFoundError('OrderNote');
    await note.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.note_delete',
      entityType: 'Order',
      entityId: orderId,
      before: { noteId: note.id, visibility: note.visibility, body: note.body },
      req,
      transaction,
    });
  });
}

/** The notes the customer may read, oldest first — for the storefront tracking page. */
async function publicNotes(orderId) {
  const notes = await db.OrderNote.findAll({
    where: { orderId, visibility: 'public' },
    attributes: ['body', 'createdAt'],
    order: [['createdAt', 'ASC']],
  });
  return notes.map((n) => ({ body: n.body, createdAt: n.createdAt }));
}

module.exports = {
  SOURCES,
  NOTE_VISIBILITY,
  MAX_TAGS,
  normalizeTags,
  sourceFor,
  isTestRequest,
  updateMeta,
  metaOf,
  listTags,
  listNotes,
  addNote,
  deleteNote,
  publicNotes,
};
