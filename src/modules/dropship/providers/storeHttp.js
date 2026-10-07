'use strict';

const env = require('../../../config/env');

/**
 * HTTP for the store-to-store providers (shopify.js, woocommerce.js): the
 * merchant's own store URL, https only (http to a local address only outside
 * production, for trying a mock), a timeout, and the README's error codes.
 * Credentials never go into a message.
 */

function err(code, status, message) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/** "mystore.myshopify.com" / "https://shop.com/" → "https://shop.com" (no path, no credentials). */
function storeOrigin(raw) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(String(raw || '').trim()) ? String(raw).trim() : `https://${String(raw || '').trim()}`);
  } catch {
    throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store address is not a valid URL');
  }
  const local = /^(127\.0\.0\.1|localhost)$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !env.isProduction)) {
    throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store address must start with https://');
  }
  if (url.username || url.password) throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store address must not contain a username or password');
  // A public address only (item 309), as webhooks: no private IP, no internal name — the local http mock
  // aside, outside production.
  if (!(local && !env.isProduction)) {
    try {
      require('../../webhooks/webhookUrlGuard').checkUrl(url.origin, 'storeUrl');
    } catch {
      throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store address must be a public https address');
    }
  }
  return url.origin;
}

const MAX_ANSWER_BYTES = 5 * 1024 * 1024;

/**
 * One request to the merchant's store (item 309): resolved through the URL guard's lookup (a public
 * name that points inside is refused too), no redirects, at most MAX_ANSWER_BYTES of answer.
 * Resolves { status, json }.
 */
function send(method, url, { headers, body, timeoutMs }) {
  const target = new URL(url);
  const local = /^(127\.0\.0\.1|localhost)$/i.test(target.hostname) && !env.isProduction;
  const client = target.protocol === 'https:' ? require('https') : require('http');
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolveOuter, rejectOuter) => {
    // One deadline for the whole exchange (item 318), beside the socket's idle timeout.
    let deadline = null;
    const resolve = (v) => { clearTimeout(deadline); resolveOuter(v); };
    const reject = (e) => { clearTimeout(deadline); rejectOuter(e); };
    // An IP written in the address is not looked up, so the lookup guard can't see it: checked here.
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const guard = require('../../webhooks/webhookUrlGuard');
    if (!local && require('net').isIP(host) && guard.isPrivateAddress(host) && !env.webhooks.allowPrivateUrls) {
      reject(new guard.BlockedAddressError(host));
      return;
    }
    const req = client.request(target, {
      method,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
      timeout: timeoutMs,
      ...(local ? {} : { lookup: require('../../webhooks/webhookUrlGuard').guardedLookup }),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) {
          req.destroy(Object.assign(new Error('answer too large'), { tooLarge: true }));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        let json = null;
        try {
          // A UTF-8 BOM some WordPress plugins put first is dropped, as fetch's res.json() did (item 318).
          let text = Buffer.concat(chunks).toString('utf8');
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

async function call(method, url, { headers = {}, body, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await send(method, url, { headers, body, timeoutMs });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timeout' : e.tooLarge ? 'the answer was too large' : e.code === 'EWEBHOOKBLOCKED' ? 'not a public address' : 'network error';
    throw err('DROPSHIP_UNAVAILABLE', 502, `The store could not be reached (${why})`);
  }
  res.ok = res.status >= 200 && res.status < 300;
  const { json } = res;
  if (res.status === 401 || res.status === 403) throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store refused the credentials');
  if (res.status === 404) throw err('DROPSHIP_PRODUCT_NOT_FOUND', 404, 'Not found in the store');
  if (res.status === 422 || res.status === 400) {
    const reason = json && (json.errors || json.message || json.error);
    throw err('DROPSHIP_ORDER_REJECTED', 409, `The store refused it: ${typeof reason === 'string' ? reason : JSON.stringify(reason || res.status).slice(0, 300)}`);
  }
  if (!res.ok) throw err('DROPSHIP_UNAVAILABLE', 502, `The store answered ${res.status}`);
  return json;
}

module.exports = { storeOrigin, call, err };
