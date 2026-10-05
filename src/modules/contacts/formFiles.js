'use strict';

const db = require('../../db/models');
const { Op } = require('sequelize');
const { AppError } = require('../../core/errors/AppError');
const { getStorage } = require('../media/storage');
const { signedUploadUrl } = require('../customerUploads/uploadLinks');

/**
 * A page form's photo and stars inputs (SPEC §9.3 "file inputs, star
 * inputs"; the element's props are checked in pages/builderExtras.js).
 *
 * Which inputs a form has is read from the published page, never from the
 * request — the same way its tags are (formService.publishedForm):
 *
 *   ratingLabel   the answer under that label must be 1–5; it is kept in the
 *                 submission's `data` like any other field.
 *   fileLabel     the answer under that label is the id of a photo the same
 *                 visitor uploaded first (POST /store/:ws/uploads,
 *                 X-Visitor-Id — JPEG, PNG or WebP, re-encoded and stripped
 *                 of metadata). Sending the form attaches it: it stops
 *                 expiring and is kept privately under `data._files`; staff
 *                 open it through a short-lived signed link, as an order's
 *                 photo. Deleting the submission deletes the photo.
 *                 `fileRequired` refuses a form sent without one.
 *
 * Only photos: the upload path re-encodes every file it keeps, which is what
 * makes a stranger's file safe to show in the dashboard; other kinds of file
 * have no such step, so they are not taken.
 */

const FILES_KEY = '_files';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const label = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Checks the stars and photo answers against the published form, before
 * anything is written. Returns the fields to keep and the photo to attach.
 */
async function prepare(workspaceId, props, body) {
  const fields = { ...(body.fields || {}) };
  delete fields[FILES_KEY];
  const p = props || {};

  const ratingLabel = label(p.ratingLabel);
  if (ratingLabel && fields[ratingLabel] !== undefined && fields[ratingLabel] !== '') {
    if (!/^[1-5]$/.test(String(fields[ratingLabel]))) throw new AppError('FORM_RATING_INVALID', 'The rating must be 1 to 5 stars', 422);
  }

  const fileLabel = label(p.fileLabel);
  let upload = null;
  if (fileLabel) {
    const uploadId = fields[fileLabel];
    delete fields[fileLabel];
    if (uploadId) {
      const visitorId = body.visitorId;
      if (!UUID.test(String(uploadId)) || !visitorId) throw fileInvalid();
      upload = await db.CustomerUpload.findOne({
        where: { id: uploadId, workspaceId, visitorId, status: 'pending', expiresAt: { [Op.gt]: new Date() } },
      });
      if (!upload) throw fileInvalid();
    } else if (p.fileRequired === true) {
      throw new AppError('FORM_FILE_REQUIRED', `"${fileLabel}" needs a photo`, 422);
    }
  }
  return { fields, upload, fileLabel };
}

function fileInvalid() {
  return new AppError('FORM_FILE_INVALID', 'The photo is missing or has expired — upload it again', 422);
}

/** Inside the submit's transaction: the photo stops expiring; returns the data to store. */
async function attach(prepared, transaction) {
  const data = { ...prepared.fields };
  if (!prepared.upload) return data;
  const [count] = await db.CustomerUpload.update(
    { status: 'attached', expiresAt: null },
    { where: { id: prepared.upload.id, status: 'pending' }, transaction }
  );
  if (count !== 1) throw fileInvalid();
  data[FILES_KEY] = [{ label: prepared.fileLabel, uploadId: prepared.upload.id }];
  return data;
}

function filesOf(data) {
  const list = data && Array.isArray(data[FILES_KEY]) ? data[FILES_KEY] : [];
  return list.filter((f) => f && typeof f.uploadId === 'string');
}

/** A submission's data as staff see it: the answers, and each photo with a fresh signed link. */
function present(data) {
  const answers = { ...(data || {}) };
  delete answers[FILES_KEY];
  const files = filesOf(data).map((f) => {
    const link = signedUploadUrl(f.uploadId);
    return { label: String(f.label || ''), url: link.url, urlExpiresAt: link.expiresAt };
  });
  return { data: answers, files };
}

/** Removes a deleted submission's photos from storage and the table. Never throws. */
async function removeFor(workspaceId, data) {
  const ids = filesOf(data).map((f) => f.uploadId);
  if (ids.length === 0) return;
  const rows = await db.CustomerUpload.findAll({ where: { id: ids, workspaceId } }).catch(() => []);
  for (const row of rows) {
    await getStorage()
      .removePrivate(row.path)
      .catch(() => {});
    await row.destroy().catch(() => {});
  }
}

module.exports = { FILES_KEY, prepare, attach, present, removeFor };
