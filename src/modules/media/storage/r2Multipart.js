'use strict';

const { CreateMultipartUploadCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const env = require('../../../config/env');
const { getClient, privateBucket } = require('./r2Storage');
const { presignUrl } = require('./s3Presign');

/**
 * Multipart upload straight to R2's private bucket (MULTIPART.md): the API
 * opens the upload and signs one URL per part; the browser PUTs each part
 * there and keeps the ETag R2 answers with; the API completes it. The bytes
 * never pass through the API.
 *
 * The bucket's CORS must allow PUT from the dashboard's origin and expose
 * the ETag header — see MULTIPART.md.
 */

const host = () => `${env.storage.r2.accountId}.r2.cloudflarestorage.com`;
const sign = (method, key, query, expiresIn) =>
  presignUrl({
    method,
    host: host(),
    path: `/${privateBucket()}/${key}`,
    query,
    accessKeyId: env.storage.r2.accessKeyId,
    secretAccessKey: env.storage.r2.secretAccessKey,
    expiresIn,
  });

async function create({ key, contentType }) {
  const res = await getClient().send(new CreateMultipartUploadCommand({ Bucket: privateBucket(), Key: key, ContentType: contentType, CacheControl: 'private, no-store' }));
  return { uploadId: res.UploadId };
}

/** Where the browser PUTs part `partNumber` (1-based). */
async function presignPart({ key, uploadId, partNumber, expiresIn = 3600 }) {
  return { url: sign('PUT', key, { partNumber: String(partNumber), uploadId }, expiresIn) };
}

async function complete({ key, uploadId, parts }) {
  await getClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: privateBucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    })
  );
}

async function abort({ key, uploadId }) {
  await getClient().send(new AbortMultipartUploadCommand({ Bucket: privateBucket(), Key: key, UploadId: uploadId }));
}

/** The stored object's size, or null when it is not there. */
async function head(key) {
  try {
    const res = await getClient().send(new HeadObjectCommand({ Bucket: privateBucket(), Key: key }));
    return { sizeBytes: Number(res.ContentLength || 0) };
  } catch (err) {
    if (err && (err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
    throw err;
  }
}

/** A short-lived link that downloads the object under `filename`. */
async function presignGet({ key, filename, contentType, expiresIn = 300 }) {
  return sign(
    'GET',
    key,
    {
      'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      ...(contentType ? { 'response-content-type': contentType } : {}),
    },
    expiresIn
  );
}

module.exports = { name: 'r2', create, presignPart, complete, abort, head, presignGet };
