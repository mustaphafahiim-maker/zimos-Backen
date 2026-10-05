'use strict';

const http = require('http');
const https = require('https');
const { guardedLookup } = require('./webhookUrlGuard');

/**
 * One POST to a merchant's webhook URL. Resolves — never rejects — with
 * `{ status }` for any HTTP answer, or `{ status: null, error }` when there
 * was no answer (refused, timed out, blocked address, TLS failure).
 *
 * Plain http(s).request rather than fetch, for two reasons: its `lookup`
 * option lets webhookUrlGuard check the very address the socket connects to,
 * and it never follows a redirect — a 3xx is simply a non-2xx answer, so a
 * public URL cannot bounce the request onto our own network.
 *
 * The receiver's response body is read and thrown away: we keep the status
 * code, never what a merchant's server chose to send back.
 */
function send({ url, body, headers, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    let target;
    try {
      target = new URL(url);
    } catch (err) {
      finish({ status: null, error: 'Invalid URL' });
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup: guardedLookup,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => finish({ status: res.statusCode }));
        res.on('error', () => finish({ status: res.statusCode }));
      }
    );

    // `timeout` above is the socket going idle; this is the whole exchange.
    deadline = setTimeout(() => req.destroy(new Error(`No response within ${timeoutMs} ms`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`No response within ${timeoutMs} ms`)));
    req.on('error', (err) => finish({ status: null, error: err.message }));
    req.end(body);
  });
}

module.exports = { send };
