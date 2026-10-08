'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { getStorage } = require('../media/storage');
const { processCustomerImage } = require('../media/imageProcessing');
const { ACCEPTED_IMAGE_TYPES } = require('../customerUploads/customerUploadService');

/**
 * A shopper's payment screenshot for an order (manualPayments), through the
 * same guards as a shopper's product photo (customerUploads): multer refuses
 * anything over the raw cap while it streams in (customerUploadController.
 * acceptFile, 5 MB); the type is decided from the bytes (JPEG, PNG or WebP —
 * no GIF, no SVG); sharp re-encodes it upright with no metadata (EXIF and
 * location gone), at most 2400px and 5 MB. Stored privately as
 * customer-uploads/<workspaceId>/<uuid>.<ext> and recorded as `attached` at
 * once, so the sweep of unclaimed uploads never removes it; staff see it only
 * through a signed, short-lived link (uploadLinks).
 *
 * Ziad put this in customerUploadService (his f74f4c1); here it sits in its
 * own file and reuses that module's exported checks, so the shoppers' photo
 * uploads are untouched.
 */
async function createPaymentProofUpload(workspaceId, file, transaction) {
  if (!file || !file.buffer) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);
  if (!ACCEPTED_IMAGE_TYPES.some((sig) => sig.match(file.buffer))) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG or WebP photos are accepted', 415);
  }
  const processed = await processCustomerImage(file.buffer);
  const key = `customer-uploads/${workspaceId}/${crypto.randomUUID()}.${processed.ext}`;
  await getStorage().putPrivate({ key, buffer: processed.buffer, contentType: processed.mime });
  try {
    return await db.CustomerUpload.create(
      {
        workspaceId,
        path: key,
        mime: processed.mime,
        sizeBytes: processed.buffer.length,
        width: processed.width,
        height: processed.height,
        visitorId: 'payment-proof',
        status: 'attached',
        expiresAt: null,
      },
      { transaction }
    );
  } catch (err) {
    // No row, no way to find the object again: remove it now.
    await getStorage()
      .removePrivate(key)
      .catch(() => {});
    throw err;
  }
}

module.exports = { createPaymentProofUpload };
