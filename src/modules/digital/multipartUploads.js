'use strict';

const crypto = require('crypto');
const path = require('path');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getMultipart } = require('../media/storage');

/**
 * Large files for the digital file library (SPEC §18.2: "upload large files
 * … via multipart upload directly to R2 (presigned)"). The browser sends the
 * bytes straight to private storage in parts; the API only opens the upload,
 * signs a URL per part, and completes it — so a 10 GB file never passes
 * through (or sits in the memory of) the API. The storage side is
 * media/storage/MULTIPART.md: R2 for real, the signed local stand-in in the
 * sandbox.
 *
 *   POST   /workspaces/:ws/digital/files/multipart                 { name, sizeBytes, mimeType }
 *   POST   /workspaces/:ws/digital/files/multipart/:id/parts       { partNumbers: [1, 2, …] } → a URL each
 *   POST   /workspaces/:ws/digital/files/multipart/:id/complete    { parts: [{ partNumber, etag }] } → the file
 *   DELETE /workspaces/:ws/digital/files/multipart/:id             abort
 *
 * The plan's storage limit counts the declared size up front, uploads in
 * progress included. Completing checks the stored size against the declared
 * one. An upload left unfinished for a day is aborted the next time the store
 * starts one.
 */

const MAX_BYTES = 10 * 1024 ** 3;
// Parts of 64 MB: a 10 GB file is 160 parts, far inside S3's 10,000, and each
// part is above its 5 MB minimum.
const PART_SIZE = 64 * 1024 * 1024;
const STALE_MS = 24 * 3600 * 1000;
const PART_URL_TTL = 3600;

const notFound = () => new AppError('UPLOAD_NOT_FOUND', 'This upload is gone. Start it again.', 404);

async function abortQuietly(upload) {
  await getMultipart()
    .abort({ key: upload.storageKey, uploadId: upload.uploadId })
    .catch((err) => logger.warn(`[digital] could not abort upload ${upload.id}: ${err.message}`));
  await upload.destroy();
}

async function cleanStale(workspaceId) {
  const stale = await db.DigitalUpload.findAll({ where: { workspaceId, createdAt: { [db.Sequelize.Op.lt]: new Date(Date.now() - STALE_MS) } } });
  for (const upload of stale) await abortQuietly(upload);
}

/** The plan's storage room, counting uploads still in progress. */
async function assertRoom(workspaceId, sizeBytes) {
  const planLimits = require('../billing/planLimits');
  const allowed = await planLimits.limitFor(workspaceId, 'storage_bytes');
  if (allowed === null) return;
  const [used, pending] = await Promise.all([planLimits.usageFor(workspaceId, 'storage_bytes'), db.DigitalUpload.sum('sizeBytes', { where: { workspaceId } })]);
  const total = Number(used) + Number(pending || 0);
  if (total + sizeBytes > allowed) {
    throw new AppError('PLAN_LIMIT_REACHED', `Your plan allows ${allowed} of this. Upgrade the plan to add more.`, 402, { limit: 'storage_bytes', allowed, used: total });
  }
}

function view(upload) {
  return { id: upload.id, name: upload.name, sizeBytes: Number(upload.sizeBytes), partSize: upload.partSize, partCount: upload.partCount };
}

async function start(workspaceId, body, req) {
  await cleanStale(workspaceId);
  if (body.sizeBytes > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'A file can be at most 10 GB', 413, { maxBytes: MAX_BYTES });
  await assertRoom(workspaceId, body.sizeBytes);
  const name = path.basename(body.name).replace(/[\u0000-\u001f]/g, '').slice(0, 300) || 'file';
  const mimeType = (body.mimeType || 'application/octet-stream').slice(0, 150);
  const id = crypto.randomUUID();
  const storageKey = `digital/${workspaceId}/${id}`;
  const { uploadId } = await getMultipart().create({ key: storageKey, contentType: mimeType });
  const upload = await db.DigitalUpload.create({
    id,
    workspaceId,
    uploadId,
    storageKey,
    name,
    mimeType,
    sizeBytes: body.sizeBytes,
    partSize: PART_SIZE,
    partCount: Math.max(1, Math.ceil(body.sizeBytes / PART_SIZE)),
    uploadedByUserId: req.user.id,
  });
  return view(upload);
}

async function load(workspaceId, id) {
  const upload = await db.DigitalUpload.findOne({ where: { id, workspaceId } });
  if (!upload) throw notFound();
  return upload;
}

async function signParts(workspaceId, id, partNumbers) {
  const upload = await load(workspaceId, id);
  const bad = partNumbers.find((n) => n > upload.partCount);
  if (bad) throw new AppError('VALIDATION_ERROR', `This file has ${upload.partCount} parts`, 422);
  const storage = getMultipart();
  const parts = [];
  for (const partNumber of partNumbers) {
    const { url } = await storage.presignPart({ key: upload.storageKey, uploadId: upload.uploadId, partNumber, expiresIn: PART_URL_TTL });
    parts.push({ partNumber, url });
  }
  return { parts, expiresAt: new Date(Date.now() + PART_URL_TTL * 1000) };
}

async function complete(workspaceId, id, parts, req) {
  const upload = await load(workspaceId, id);
  const numbers = parts.map((p) => p.partNumber).sort((a, b) => a - b);
  if (numbers.length !== upload.partCount || numbers.some((n, i) => n !== i + 1)) {
    throw new AppError('UPLOAD_INCOMPLETE', `Send all ${upload.partCount} parts, each once`, 422);
  }
  const storage = getMultipart();
  try {
    await storage.complete({ key: upload.storageKey, uploadId: upload.uploadId, parts });
  } catch (err) {
    logger.warn(`[digital] completing upload ${upload.id} failed: ${err.message}`);
    throw new AppError('UPLOAD_FAILED', 'The file could not be put together. Upload it again.', 422);
  }
  const stored = await storage.head(upload.storageKey);
  if (!stored || stored.sizeBytes !== Number(upload.sizeBytes)) {
    await require('../media/storage').getStorage().removePrivate(upload.storageKey).catch(() => {});
    await upload.destroy();
    throw new AppError('UPLOAD_SIZE_MISMATCH', 'The uploaded file is not the size that was announced. Upload it again.', 422);
  }

  const file = await db.sequelize.transaction(async (transaction) => {
    const row = await db.DigitalFile.create(
      {
        id: upload.id,
        workspaceId,
        name: upload.name,
        storageKey: upload.storageKey,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        uploadedByUserId: req.user.id,
      },
      { transaction }
    );
    await upload.destroy({ transaction });
    return row;
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'digital_file.upload',
    entityType: 'DigitalFile',
    entityId: file.id,
    after: { name: file.name, sizeBytes: Number(file.sizeBytes), multipart: true },
    req,
  });
  return { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: Number(file.sizeBytes), createdAt: file.createdAt, usedByProducts: 0 };
}

async function abort(workspaceId, id) {
  const upload = await db.DigitalUpload.findOne({ where: { id, workspaceId } });
  if (upload) await abortQuietly(upload);
}

// ------------------------------------------------------------------ routes --

const uuid = Joi.string().uuid();
const params = Joi.object({ workspaceId: uuid.required(), uploadId: uuid.required() });
const router = Router({ mergeParams: true });
router.use(requirePermission(P.PRODUCTS_MANAGE));

router.post(
  '/',
  validate({
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().trim().min(1).max(300).required(),
      sizeBytes: Joi.number().integer().min(1).required(),
      mimeType: Joi.string().max(150).allow('', null),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ upload: await start(req.tenant.workspaceId, req.body, req) }))
);
router.post(
  '/:uploadId/parts',
  validate({ params, body: Joi.object({ partNumbers: Joi.array().items(Joi.number().integer().min(1).max(10000)).min(1).max(50).unique().required() }) }),
  asyncHandler(async (req, res) => res.json(await signParts(req.tenant.workspaceId, req.params.uploadId, req.body.partNumbers)))
);
router.post(
  '/:uploadId/complete',
  validate({
    params,
    body: Joi.object({
      parts: Joi.array()
        .items(Joi.object({ partNumber: Joi.number().integer().min(1).max(10000).required(), etag: Joi.string().max(200).required() }))
        .min(1)
        .max(10000)
        .required(),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ file: await complete(req.tenant.workspaceId, req.params.uploadId, req.body.parts, req) }))
);
router.delete(
  '/:uploadId',
  validate({ params }),
  asyncHandler(async (req, res) => {
    await abort(req.tenant.workspaceId, req.params.uploadId);
    res.status(204).end();
  })
);

module.exports = { router, MAX_BYTES, PART_SIZE, start, signParts, complete, abort };
