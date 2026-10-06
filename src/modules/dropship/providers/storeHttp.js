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
  return url.origin;
}

async function call(method, url, { headers = {}, body, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw err('DROPSHIP_UNAVAILABLE', 502, `The store could not be reached (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
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
