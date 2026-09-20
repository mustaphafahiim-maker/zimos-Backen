'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getStorage, UPLOAD_ROOT } = require('./storage');

const MAX_BYTES = 5 * 1024 * 1024;
// 3D product models are legitimately larger than an image, so they get their
// own ceiling; everything else stays on MAX_BYTES.
const MAX_MODEL_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_BYTES = Math.max(MAX_BYTES, MAX_MODEL_BYTES);

// Type is decided by the actual file bytes, never the filename or the
// client-declared mimetype.
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', match: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { mime: 'image/jpeg', ext: 'jpg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', match: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('latin1', 0, 6)) },
  {
    mime: 'image/webp',
    ext: 'webp',
    match: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
  // Binary glTF — the 3D product model a shopper can rotate on the storefront.
  // Header is 'glTF' + version 2 + total length, so a truncated upload is
  // rejected here rather than failing in the browser.
  {
    mime: 'model/gltf-binary',
    ext: 'glb',
    isModel: true,
    match: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2,
  },
];

function detectImage(buffer) {
  return SIGNATURES.find((s) => s.match(buffer)) || null;
}

async function storeImage(workspaceId, file, req) {
  if (!file) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);

  const sig = detectImage(file.buffer);
  if (!sig) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only PNG, JPEG, GIF or WEBP images, or GLB 3D models, are accepted', 415);
  }
  const limit = sig.isModel ? MAX_MODEL_BYTES : MAX_BYTES;
  if (file.size > limit) {
    throw new AppError('FILE_TOO_LARGE', `The file exceeds the ${Math.round(limit / (1024 * 1024))}MB limit`, 413);
  }

  const filename = `${crypto.randomUUID()}.${sig.ext}`;
  const { url, path } = await getStorage().put({
    workspaceId,
    filename,
    buffer: file.buffer,
    contentType: sig.mime,
  });

  const asset = await db.MediaAsset.create({
    workspaceId,
    uploadedByUserId: req.user ? req.user.id : null,
    url,
    path,
    mimeType: sig.mime,
    sizeBytes: file.size,
  });
  const result = { id: asset.id, url, path, mimeType: sig.mime, size: file.size };

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'media.upload',
    entityType: 'Media',
    entityId: filename,
    after: result,
    req,
  });

  return result;
}

/** Newest first; `before` is the createdAt of the last item of the previous page. */
async function listMedia(workspaceId, { limit = 60, before } = {}) {
  const where = { workspaceId };
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.MediaAsset.findAll({ where, order: [['createdAt', 'DESC']], limit: Math.min(200, Number(limit) || 60) });
  const media = rows.map((m) => ({ id: m.id, url: m.url, mimeType: m.mimeType, size: m.sizeBytes, createdAt: m.createdAt }));
  return { media, nextCursor: rows.length === Math.min(200, Number(limit) || 60) ? rows[rows.length - 1].createdAt.toISOString() : null };
}

/**
 * Removes the image from the library. The stored file is kept: storage
 * backends have no delete yet, and a page or product may still reference it.
 */
async function deleteMedia(workspaceId, mediaId, req) {
  const asset = await db.MediaAsset.findOne({ where: { id: mediaId, workspaceId } });
  if (!asset) throw new NotFoundError('Media');
  await asset.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'media.delete',
    entityType: 'Media',
    entityId: asset.id,
    before: { url: asset.url },
    req,
  });
  return { deleted: true, id: asset.id };
}

module.exports = { storeImage, detectImage, listMedia, deleteMedia, UPLOAD_ROOT, MAX_BYTES, MAX_MODEL_BYTES, MAX_UPLOAD_BYTES };
