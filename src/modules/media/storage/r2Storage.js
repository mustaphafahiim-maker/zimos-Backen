'use strict';

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const env = require('../../../config/env');

// Cloudflare R2 is S3-compatible. The bucket is served publicly from
// R2_PUBLIC_URL (an r2.dev URL or a custom domain configured in the
// dashboard); the returned `url` is that prefix + the object key.
let client = null;
function getClient() {
  const { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl } = env.storage.r2;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
    throw new Error(
      'R2 storage is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_URL)'
    );
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }
  return client;
}

async function put({ workspaceId, filename, buffer, contentType }) {
  const s3 = getClient();
  const key = `${workspaceId}/${filename}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.storage.r2.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return {
    url: `${env.storage.r2.publicUrl}/${key}`,
    path: `/${key}`,
  };
}

/**
 * Deletes one object by the `path` put() returned ("/<workspaceId>/<file>").
 * S3 DeleteObject is idempotent — removing a key that is already gone
 * succeeds — so this only throws on a real connectivity/permission failure.
 */
async function remove(storagePath) {
  const s3 = getClient();
  const key = String(storagePath).replace(/^\/+/, '');
  await s3.send(new DeleteObjectCommand({ Bucket: env.storage.r2.bucketName, Key: key }));
}

/**
 * Reads one media object back by the `path` put() returned — for maintenance
 * scripts (scripts/strip-media-exif.js), never a request path. Null when gone.
 */
async function get(storagePath) {
  const s3 = getClient();
  const key = String(storagePath).replace(/^\/+/, '');
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: env.storage.r2.bucketName, Key: key }));
    return { buffer: Buffer.from(await res.Body.transformToByteArray()), contentType: res.ContentType || null };
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
    throw err;
  }
}

/*
 * Private objects: shoppers' photos (customer-uploads/<workspaceId>/<uuid>).
 * They go to R2_PRIVATE_BUCKET_NAME when it is set — a bucket with no public
 * access at all — and otherwise to the media bucket under the
 * customer-uploads/ prefix. Their URL is never built from R2_PUBLIC_URL and
 * never handed out: the merchant reads them through the API's signed,
 * short-lived link (customerUploads/uploadLinks.js), which streams them from
 * here. With the shared bucket the key is a random UUID nobody is told; the
 * private bucket (or a rule blocking /customer-uploads/* on the public
 * domain) closes even that.
 */
const privateBucket = () => env.storage.r2.privateBucketName || env.storage.r2.bucketName;

async function putPrivate({ key, buffer, contentType }) {
  const s3 = getClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: privateBucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'private, no-store',
    })
  );
  return { path: key };
}

/** The object's bytes and type, or null when it is gone. */
async function getPrivate(key) {
  const s3 = getClient();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: privateBucket(), Key: key }));
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    return { buffer: bytes, contentType: res.ContentType || null };
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
    throw err;
  }
}

async function removePrivate(key) {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: privateBucket(), Key: key }));
}

// Lets tests reset the memoized client between provider switches.
function _resetClient() {
  client = null;
}

/**
 * Health probe for /admin/system/services. HeadBucket is the cheapest call
 * that proves the credentials, the endpoint and the bucket all work; it writes
 * nothing, so running it on every admin page load costs a request and no
 * storage. getClient() throws when R2 is half-configured, which the caller
 * reports as a failed probe rather than a crash.
 */
async function probe() {
  const s3 = getClient();
  await s3.send(new HeadBucketCommand({ Bucket: env.storage.r2.bucketName }));
  return { detail: `r2 bucket "${env.storage.r2.bucketName}"` };
}

module.exports = { put, get, remove, probe, putPrivate, getPrivate, removePrivate, _resetClient, getClient, privateBucket };
