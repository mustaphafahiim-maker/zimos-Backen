'use strict';

const multer = require('multer');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const service = require('./customerUploadService');
const { verifyUploadLink } = require('./uploadLinks');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.customerUploads.maxRawBytes, files: 1, fields: 4, fieldSize: 200 },
});

// A file over the raw cap (5 MB, CUSTOMER_UPLOAD_MAX_MB) is refused while it
// streams in — never processed. Shoppers' photos, transfer receipts and
// manual-payment proofs all come through here; the merchant's own media
// library has its larger cap (item 400).
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxBytes = env.customerUploads.maxRawBytes;
        const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
        return next(new AppError('FILE_TOO_LARGE', `The photo is larger than ${maxMb} MB`, 413, { kind: 'photo', maxBytes, maxMb }));
      }
      return next(new AppError('UPLOAD_ERROR', err.message, 422));
    }
    return next(err);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /store/:workspaceId/uploads — multipart: `file`, optional `productId`.
const create = asyncHandler(async (req, res) => {
  const visitorId = service.readVisitorId(req);
  const productId = req.body && req.body.productId ? String(req.body.productId) : null;
  if (productId && !UUID.test(productId)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid body', 422, [{ field: 'productId', message: 'must be a valid GUID' }]);
  }
  const result = await service.createUpload(req.tenant.workspaceId, { file: req.file, visitorId, productId });
  res.status(201).json({ upload: result });
});

// GET /customer-uploads/:uploadId?expires=&signature= — the signed link staff open.
const readSigned = asyncHandler(async (req, res) => {
  const { uploadId } = req.params;
  if (!UUID.test(uploadId) || !verifyUploadLink(uploadId, req.query.expires, req.query.signature)) {
    // The same answer for a forged, an expired and an unknown link.
    throw new NotFoundError('Upload');
  }
  const file = await service.readUpload(uploadId);
  if (!file) throw new NotFoundError('Upload');
  const remaining = Math.max(0, Number(req.query.expires) - Math.floor(Date.now() / 1000));
  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.buffer.length),
    'Cache-Control': `private, max-age=${remaining}`,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    // Some browsers render images in a document context; nothing may run there.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.end(file.buffer);
});

module.exports = { acceptFile, create, readSigned };
