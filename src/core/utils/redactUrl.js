'use strict';

/**
 * A request URL safe to log: gateway signatures in the query string and the
 * webhook tokens in callback paths (per merchant, and the billing gateway's
 * FAWATERAK_WEBHOOK_TOKEN) are replaced with "[redacted]". Anyone holding a
 * callback URL's token and a valid signature could replay it, so neither
 * belongs in a log.
 *
 * The storefront's links that are a secret in themselves are hidden the same
 * way: a shopper's subscription portal (/store/:ws/subscriptions/:token…), a
 * digital download (/store/:ws/downloads/:token…, not /downloads/order/…) and
 * an abandoned-cart recovery link (/store/:ws/recover/:token). In the query:
 * the gateway signatures, `token` and `secret`, the WhatsApp inbox's
 * event-stream `ticket` and the Google sign-in's one-time `code`.
 */

const SECRET_PARAMS = new Set(['hmac', 'signature', 'sig', 'x-signature', 'token', 'secret', 'ticket', 'code']);
const WEBHOOK_PATH = /(\/(?:webhooks\/(?:payments|carriers)\/[^/?#]+|billing\/fawaterak)\/)[^/?#]+/i;
const STORE_TOKEN_PATH = /(\/store\/[^/?#]+\/(?:subscriptions|downloads(?!\/order(?:[/?#]|$))|recover)\/)[^/?#]+/i;

function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const [pathAndQuery, hash = ''] = url.split('#');
  const q = pathAndQuery.indexOf('?');
  let path = q === -1 ? pathAndQuery : pathAndQuery.slice(0, q);
  let query = q === -1 ? '' : pathAndQuery.slice(q + 1);

  path = path.replace(WEBHOOK_PATH, '$1[redacted]').replace(STORE_TOKEN_PATH, '$1[redacted]');
  if (query) {
    query = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        let name = key;
        try {
          name = decodeURIComponent(key);
        } catch (err) {
          name = key;
        }
        return SECRET_PARAMS.has(name.toLowerCase()) ? `${key}=[redacted]` : pair;
      })
      .join('&');
  }
  return `${path}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

module.exports = { redactUrl };
