'use strict';

const http = require('http');
const https = require('https');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { checkUrl, guardedLookup } = require('../webhooks/webhookUrlGuard');
const localStorage = require('../media/storage/localStorage');
const r2Storage = require('../media/storage/r2Storage');

/**
 * The store logo is a URL the merchant types, and the waybill PDF is drawn
 * on this server, so reading it is a request our server makes on the
 * merchant's behalf: the same risk as a webhook (webhookUrlGuard.js). So:
 *
 *   - when it is saved, it must be http(s) and not name a private address or
 *     an internal hostname outright — checkLogoUrl(), 422 otherwise
 *   - when it is read, a logo we host ourselves (/uploads on this API, or the
 *     R2 public bucket) is read from storage with no request at all; any
 *     other URL is checked again (a row saved before this check existed) and
 *     fetched with guardedLookup, never following a redirect, for at most
 *     LOGO_TIMEOUT_MS and LOGO_MAX_BYTES, and only a PNG or JPEG is kept.
 *
 * fetchLogo never throws: a logo it cannot read is no logo.
 */

const LOGO_TIMEOUT_MS = 3000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_URL_RULES = { allowHttp: true, label: 'logo URL' };

/** Refuses (422) a logo URL that points inside our network. */
function checkLogoUrl(value) {
  if (value) checkUrl(value, 'logoUrl', LOGO_URL_RULES);
}

// pdfkit draws PNG and JPEG only; the bytes decide, not the header.
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const usable = (buffer) => (buffer && buffer.length <= LOGO_MAX_BYTES && (isPng(buffer) || isJpeg(buffer)) ? buffer : null);

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch (err) {
    return null;
  }
};

// The storage backend and key of a logo we host ourselves, or null.
function ownStorageObject(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (url.origin === originOf(env.appUrl) && pathname.startsWith('/uploads/')) {
    return { backend: localStorage, key: pathname };
  }
  const r2Public = env.storage.r2.publicUrl;
  const bare = `${url.origin}${pathname}`;
  if (env.storage.provider === 'r2' && r2Public && bare.startsWith(`${r2Public}/`)) {
    return { backend: r2Storage, key: `/${bare.slice(r2Public.length + 1)}` };
  }
  return null;
}

// GET with guardedLookup, no redirects, a hard deadline and a size cap.
function fetchRemote(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    let timer = null;
    let req = null;
    const fail = (err) => {
      clearTimeout(timer);
      if (req) req.destroy();
      reject(err);
    };
    req = client.get(
      url,
      { lookup: guardedLookup, headers: { accept: 'image/png, image/jpeg', 'user-agent': 'ZimosWaybill/1.0' } },
      (res) => {
        const type = String(res.headers['content-type'] || '');
        if (res.statusCode !== 200) return fail(new Error(`answered ${res.statusCode}`));
        if (!/^image\/(png|jpe?g)\b/i.test(type)) return fail(new Error(`not a PNG or JPEG (${type || 'no type'})`));
        if (Number(res.headers['content-length']) > LOGO_MAX_BYTES) return fail(new Error('too large'));
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LOGO_MAX_BYTES) fail(new Error('too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
        res.on('error', fail);
        return undefined;
      }
    );
    timer = setTimeout(() => fail(new Error('timed out')), LOGO_TIMEOUT_MS);
    req.on('error', fail);
  });
}

/** The logo's bytes (PNG or JPEG), or null. Never throws. */
async function fetchLogo(value) {
  if (!value) return null;
  let host = '';
  try {
    const url = new URL(value);
    host = url.host;
    const own = ownStorageObject(url);
    if (own) {
      const object = await own.backend.get(own.key);
      return usable(object && object.buffer);
    }
    checkUrl(value, 'logoUrl', LOGO_URL_RULES);
    return usable(await fetchRemote(url));
  } catch (err) {
    const reason = (err.details && err.details[0] && err.details[0].message) || err.message;
    logger.warn(`[waybill] logo not read from ${host || 'an invalid URL'}: ${reason}`);
    return null;
  }
}

module.exports = { checkLogoUrl, fetchLogo, LOGO_MAX_BYTES, LOGO_TIMEOUT_MS };
