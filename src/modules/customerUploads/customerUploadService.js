'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { getStorage } = require('../media/storage');
const { processCustomerImage } = require('../media/imageProcessing');
const { signedUploadUrl } = require('./uploadLinks');

/*
 * Photos shoppers attach to an order through a product's image field.
 *
 *   upload    POST /store/:workspaceId/uploads, no login. The raw file is
 *             capped (15 MB, refused before any processing), its type decided
 *             from its bytes (JPEG, PNG or WebP — no GIF, no SVG), then
 *             re-encoded by sharp: upright, no metadata, at most 2400px, at
 *             most 5 MB. Stored privately as
 *             customer-uploads/<workspaceId>/<uuid>.<ext> — never in the
 *             merchant's media library — and recorded as `pending`, expiring
 *             after CUSTOMER_UPLOAD_TTL_HOURS (48). The shopper gets its id.
 *   order     the order line that names it attaches it (catalog/customFields).
 *   sweep     pending ones past their expiry go from storage and the table.
 *   view      staff see it through a signed, short-lived link (uploadLinks).
 */

// Content sniffing, as mediaService does it; GIF and anything else is refused.
const ACCEPTED = [
  { mime: 'image/jpeg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', match: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  {
    mime: 'image/webp',
    match: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The visitor id header, or a 400 explaining it is needed. */
function readVisitorId(req) {
  const value = req.headers['x-visitor-id'];
  if (typeof value !== 'string' || !VISITOR_ID.test(value)) {
    throw new AppError('VISITOR_ID_REQUIRED', 'Send the X-Visitor-Id header (8–64 letters, digits, - or _)', 400);
  }
  return value;
}

async function createUpload(workspaceId, { file, visitorId, productId }) {
  if (!file || !file.buffer) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);
  if (!ACCEPTED.some((sig) => sig.match(file.buffer))) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG or WebP photos are accepted', 415);
  }

  if (productId) {
    const product = await db.Product.findOne({ where: { id: productId, workspaceId, status: 'active' }, attributes: ['id', 'customFields'] });
    const hasPhotoField = product && (product.customFields || []).some((f) => f.type === 'image');
    if (!hasPhotoField) throw new NotFoundError('Product');
  }

  const pending = await db.CustomerUpload.count({ where: { workspaceId, visitorId, status: 'pending' } });
  if (pending >= env.customerUploads.maxPendingPerVisitor) {
    throw new AppError('TOO_MANY_PENDING_UPLOADS', 'Too many photos are waiting for an order. Place the order or try again later.', 429);
  }

  const processed = await processCustomerImage(file.buffer);
  const key = `customer-uploads/${workspaceId}/${crypto.randomUUID()}.${processed.ext}`;
  await getStorage().putPrivate({ key, buffer: processed.buffer, contentType: processed.mime });

  const expiresAt = new Date(Date.now() + env.customerUploads.pendingTtlHours * 60 * 60 * 1000);
  try {
    const row = await db.CustomerUpload.create({
      workspaceId,
      path: key,
      mime: processed.mime,
      sizeBytes: processed.buffer.length,
      width: processed.width,
      height: processed.height,
      visitorId,
      productId: productId || null,
      status: 'pending',
      expiresAt,
    });
    return {
      uploadId: row.id,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      expiresAt: row.expiresAt,
    };
  } catch (err) {
    // No row, no way to find the object again: remove it now.
    await getStorage()
      .removePrivate(key)
      .catch(() => {});
    throw err;
  }
}

/**
 * Deletes pending photos past their expiry, from storage first and then the
 * table, one batch per transaction. A storage failure leaves that row for the
 * next sweep. Each batch takes a transaction-scoped advisory lock, so two
 * replicas never sweep at once, and skips rows an order is attaching right
 * now (FOR UPDATE SKIP LOCKED). Returns how many were removed.
 */
async function sweepExpiredUploads({ now = new Date(), batchSize = 200 } = {}) {
  let removed = 0;
  for (;;) {
    const result = await db.sequelize.transaction(async (transaction) => {
      const [{ locked }] = await db.sequelize.query('SELECT pg_try_advisory_xact_lock(hashtext($key)) AS locked', {
        bind: { key: 'customer-uploads-sweep' },
        type: QueryTypes.SELECT,
        transaction,
      });
      if (!locked) return { seen: 0, gone: 0 };
      const rows = await db.CustomerUpload.findAll({
        where: { status: 'pending', expiresAt: { [db.Sequelize.Op.lt]: now } },
        order: [['expiresAt', 'ASC']],
        limit: batchSize,
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      const gone = [];
      for (const row of rows) {
        try {
          await getStorage().removePrivate(row.path);
          gone.push(row.id);
        } catch (err) {
          logger.error(`customer upload sweep: "${row.path}" was not removed: ${err.message}`, { uploadId: row.id });
        }
      }
      if (gone.length > 0) await db.CustomerUpload.destroy({ where: { id: gone }, transaction });
      return { seen: rows.length, gone: gone.length };
    });
    removed += result.gone;
    if (result.seen < batchSize || result.gone < result.seen) break;
  }
  if (removed > 0) logger.info(`customer upload sweep: removed ${removed} expired photo(s)`);
  return removed;
}

/** Starts the in-process sweep (CUSTOMER_UPLOAD_SWEEP_MINUTES; 0 = off). */
function startUploadSweep() {
  const minutes = env.customerUploads.sweepMinutes;
  if (!minutes || minutes <= 0) return null;
  const run = () =>
    sweepExpiredUploads().catch((err) => logger.error(`customer upload sweep failed: ${err.message}`));
  const timer = setInterval(run, minutes * 60 * 1000);
  timer.unref();
  return timer;
}

/** A photo's bytes for a verified link: the row decides the type. Null when gone. */
async function readUpload(uploadId) {
  const row = await db.CustomerUpload.findByPk(uploadId);
  if (!row) return null;
  const object = await getStorage().getPrivate(row.path);
  if (!object) return null;
  return { buffer: object.buffer, mime: row.mime };
}

/**
 * A line's customizations as staff see them: each photo gains a fresh signed
 * link (`url`, `urlExpiresAt`) and its size; answers stay as snapshotted.
 */
async function presentCustomizations(workspaceId, customizations) {
  if (!Array.isArray(customizations)) return customizations || null;
  const ids = customizations.filter((e) => e.type === 'image' && e.uploadId).map((e) => e.uploadId);
  const rows = ids.length
    ? await db.CustomerUpload.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'width', 'height', 'mime'] })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return customizations.map((entry) => {
    if (entry.type !== 'image') return entry;
    const row = byId.get(entry.uploadId);
    if (!row) return { ...entry, url: null, missing: true };
    const link = signedUploadUrl(row.id);
    return { ...entry, url: link.url, urlExpiresAt: link.expiresAt, width: row.width, height: row.height, mime: row.mime };
  });
}

/** Adds signed photo links to every item of every order given (mutates the plain objects). */
async function presentOrderItems(workspaceId, items) {
  for (const item of items || []) {
    if (item && item.customizations) item.customizations = await presentCustomizations(workspaceId, item.customizations);
  }
  return items;
}

module.exports = {
  readVisitorId,
  createUpload,
  sweepExpiredUploads,
  startUploadSweep,
  readUpload,
  presentCustomizations,
  presentOrderItems,
};
