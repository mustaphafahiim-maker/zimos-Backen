'use strict';

const multer = require('multer');
const asyncHandler = require('express-async-handler');
const service = require('./mediaService');
const { AppError } = require('../../core/errors/AppError');
const { MAX_UPLOAD_BYTES, tooLarge } = require('./mediaService');

// The widest limit any accepted type allows (a video's); storeImage then
// applies the per-type ceiling (images 10 MB, GLB models 15 MB, videos 30 MB)
// and names it in the error.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Wrap multer so its errors become our standard AppError shape instead of a 500.
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      // The type is not known yet: the ceiling for any file (a video's).
      if (err.code === 'LIMIT_FILE_SIZE') return next(tooLarge('file', MAX_UPLOAD_BYTES));
      return next(new AppError('UPLOAD_ERROR', err.message, 422));
    }
    return next(err);
  });
}

const uploadMedia = asyncHandler(async (req, res) => {
  const result = await service.storeImage(req.tenant.workspaceId, req.file, req);
  res.status(201).json(result);
});

const listMedia = asyncHandler(async (req, res) => {
  res.json(await service.listMedia(req.tenant.workspaceId, req.query));
});

const deleteMedia = asyncHandler(async (req, res) => {
  res.json(await service.deleteMedia(req.tenant.workspaceId, req.params.mediaId, req));
});

module.exports = { acceptFile, uploadMedia, listMedia, deleteMedia };
