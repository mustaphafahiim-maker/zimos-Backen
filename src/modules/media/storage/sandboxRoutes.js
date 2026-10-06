'use strict';

const fs = require('fs');
const { Router } = require('express');
const { AppError } = require('../../../core/errors/AppError');
const local = require('./localMultipart');

/**
 * The sandbox's stand-in for presigned storage URLs (localMultipart.js),
 * mounted at /api/v1/storage-sandbox only with STORAGE_PROVIDER=local
 * outside production. Every request carries the HMAC signature and expiry the
 * API minted; nothing else is accepted.
 *
 *   PUT /parts/:uploadId/:partNumber?expires&signature   one part's bytes → ETag
 *   GET /objects?key&name&type&expires&signature         the finished file, as a download
 */
const router = Router();
const live = (expires) => Number.isInteger(Number(expires)) && Number(expires) * 1000 > Date.now();

router.put('/parts/:uploadId/:partNumber', async (req, res, next) => {
  try {
    const { uploadId, partNumber } = req.params;
    const { expires, signature } = req.query;
    if (!live(expires) || !local.verify(signature, 'part', uploadId, partNumber, expires)) throw new AppError('SIGNATURE_INVALID', 'This upload link is not valid', 403);
    const etag = await local.writePart(uploadId, partNumber, req);
    res.set('ETag', etag);
    res.set('Access-Control-Expose-Headers', 'ETag');
    res.json({ etag });
  } catch (err) {
    next(err.code === 'ENOENT' ? new AppError('UPLOAD_NOT_FOUND', 'This upload is gone', 404) : err);
  }
});

router.get('/objects', (req, res, next) => {
  const { key, name, type, expires, signature } = req.query;
  if (!live(expires) || !local.verify(signature, 'get', key, name, type || '', expires)) return next(new AppError('SIGNATURE_INVALID', 'This download link is not valid', 403));
  let file;
  try {
    file = local.objectPath(key);
  } catch (err) {
    return next(new AppError('NOT_FOUND', 'Not found', 404));
  }
  fs.stat(file, (err, stat) => {
    if (err) return next(new AppError('NOT_FOUND', 'Not found', 404));
    res.set('Content-Type', type || 'application/octet-stream');
    res.set('Content-Length', String(stat.size));
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return fs.createReadStream(file).pipe(res);
  });
});

module.exports = router;
