'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../../../config/env');
const { PRIVATE_ROOT } = require('./localStorage');

/**
 * The sandbox multipart adapter (MULTIPART.md) for STORAGE_PROVIDER=local:
 * the same contract as r2Multipart.js, with the "presigned" URLs pointing at
 * the API's own /storage-sandbox routes (sandboxRoutes.js), signed with an
 * HMAC and short-lived like the real ones. Parts land under
 * storage/private/.multipart/<uploadId>/ and are joined on complete.
 */

const PARTS_ROOT = path.join(PRIVATE_ROOT, '.multipart');
const MAX_PART_BYTES = 256 * 1024 * 1024;

function key() {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:storage-sandbox').digest();
}

function signature(...parts) {
  return crypto.createHmac('sha256', key()).update(parts.join('|')).digest('hex');
}

function verify(given, ...parts) {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(signature(...parts), 'hex'), Buffer.from(given, 'hex'));
}

const base = () => `${env.appUrl.replace(/\/$/, '')}/api/${env.apiVersion}/storage-sandbox`;
const target = (objectKey) => {
  const t = path.resolve(PRIVATE_ROOT, String(objectKey).replace(/^\/+/, ''));
  if (!t.startsWith(PRIVATE_ROOT + path.sep)) throw new Error(`Refusing a path outside the private root: ${objectKey}`);
  return t;
};
const uploadDir = (uploadId) => {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Bad upload id');
  return path.join(PARTS_ROOT, uploadId);
};

async function create({ key: objectKey }) {
  const uploadId = crypto.randomUUID();
  await fs.promises.mkdir(uploadDir(uploadId), { recursive: true });
  await fs.promises.writeFile(path.join(uploadDir(uploadId), 'key'), String(objectKey));
  return { uploadId };
}

async function presignPart({ uploadId, partNumber, expiresIn = 3600 }) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  return { url: `${base()}/parts/${uploadId}/${partNumber}?expires=${expires}&signature=${signature('part', uploadId, partNumber, expires)}` };
}

/** Writes one part from the request stream (sandboxRoutes.js); returns its ETag (the MD5 of its bytes, quoted, as S3 does). */
async function writePart(uploadId, partNumber, stream) {
  const dir = uploadDir(uploadId);
  await fs.promises.access(path.join(dir, 'key'));
  const hash = crypto.createHash('md5');
  let size = 0;
  const file = path.join(dir, `part-${partNumber}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PART_BYTES) {
        stream.destroy(new Error('Part too large'));
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });
  return `"${hash.digest('hex')}"`;
}

async function complete({ key: objectKey, uploadId, parts }) {
  const dir = uploadDir(uploadId);
  const stored = await fs.promises.readFile(path.join(dir, 'key'), 'utf8');
  if (stored !== String(objectKey)) throw new Error('Upload does not belong to this object');
  const out = target(objectKey);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const writer = fs.createWriteStream(out);
  for (const part of sorted) {
    const file = path.join(dir, `part-${part.partNumber}`);
    const md5 = crypto.createHash('md5');
    await new Promise((resolve, reject) => {
      const reader = fs.createReadStream(file);
      reader.on('data', (c) => md5.update(c));
      reader.on('error', reject);
      reader.on('end', resolve);
      reader.pipe(writer, { end: false });
    });
    if (`"${md5.digest('hex')}"` !== part.etag) {
      writer.destroy();
      await fs.promises.unlink(out).catch(() => {});
      const err = new Error(`Part ${part.partNumber} does not match its ETag`);
      err.code = 'InvalidPart';
      throw err;
    }
  }
  await new Promise((resolve, reject) => writer.end((err) => (err ? reject(err) : resolve())));
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function abort({ uploadId }) {
  await fs.promises.rm(uploadDir(uploadId), { recursive: true, force: true });
}

async function head(objectKey) {
  try {
    const stat = await fs.promises.stat(target(objectKey));
    return { sizeBytes: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function presignGet({ key: objectKey, filename, contentType, expiresIn = 300 }) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const q = new URLSearchParams({ key: objectKey, name: filename, type: contentType || '', expires: String(expires) });
  q.set('signature', signature('get', objectKey, filename, contentType || '', expires));
  return `${base()}/objects?${q.toString()}`;
}

/** The file to stream for a verified GET (sandboxRoutes.js). */
function objectPath(objectKey) {
  return target(objectKey);
}

module.exports = { name: 'sandbox', create, presignPart, writePart, complete, abort, head, presignGet, objectPath, verify };
