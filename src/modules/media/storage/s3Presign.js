'use strict';

const crypto = require('crypto');

/**
 * AWS Signature V4 query-string presigning for S3-compatible storage (R2),
 * written out so the API needs no extra package: a URL the browser can use
 * for one request (a multipart part's PUT, a file's GET) until it expires,
 * with no credentials of its own. The payload is UNSIGNED-PAYLOAD, as S3
 * expects for presigned uploads; only the `host` header is signed.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** RFC 3986 encoding, as SigV4 wants: everything but A–Z a–z 0–9 - _ . ~ */
function encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256 = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

/**
 * @param {object} o
 * @param {'GET'|'PUT'} o.method
 * @param {string} o.host            e.g. "<account>.r2.cloudflarestorage.com"
 * @param {string} o.path            e.g. "/<bucket>/<key>" (unencoded)
 * @param {object} [o.query]         extra query parameters (partNumber, uploadId, response-content-disposition…)
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {string} [o.region]        "auto" for R2
 * @param {number} [o.expiresIn]     seconds, at most 7 days
 * @param {Date}   [o.now]
 * @returns {string} the presigned https URL
 */
function presignUrl({ method, host, path, query = {}, accessKeyId, secretAccessKey, region = 'auto', expiresIn = 3600, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const params = {
    ...query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(Math.max(1, Math.floor(expiresIn)), 604800)),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k])}`)
    .join('&');
  const canonicalUri = String(path)
    .split('/')
    .map((segment) => encode(segment))
    .join('/');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

module.exports = { presignUrl };
