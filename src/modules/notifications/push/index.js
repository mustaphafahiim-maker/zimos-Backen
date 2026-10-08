'use strict';

const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');

/**
 * The push provider (README.md in this folder). PUSH_PROVIDER picks it;
 * unset, it is `webpush` when the VAPID keys are set, else `sandbox` outside
 * production. Production never falls back to the sandbox (set
 * PUSH_PROVIDER=sandbox on purpose), so a live server never pretends to push:
 * without keys it has no provider and says so once in the log.
 */
const PROVIDERS = {
  sandbox: () => require('./sandbox'), // eslint-disable-line global-require
  webpush: () => require('./webpush'), // eslint-disable-line global-require
};

const warned = new Set();
function warnOnce(text) {
  if (warned.has(text)) return;
  warned.add(text);
  logger.warn(`[push] ${text}`);
}

function getProvider() {
  const keysSet = Boolean(String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim() && String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim());
  const wanted = (process.env.PUSH_PROVIDER || (keysSet ? 'webpush' : env.isProduction ? '' : 'sandbox')).trim().toLowerCase();
  const load = PROVIDERS[wanted];
  if (!load) {
    if (wanted) warnOnce(`PUSH_PROVIDER=${wanted} is not a push provider (${Object.keys(PROVIDERS).join(', ')}): no push is sent`);
    else warnOnce('No push provider: set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT (node scripts/generate-vapid-keys.js). No push is sent.');
    return null;
  }
  const provider = load();
  const problem = provider.problem ? provider.problem() : null;
  if (problem) {
    warnOnce(`Web push is off: ${problem}. No push is sent.`);
    return null;
  }
  return provider;
}

module.exports = { getProvider };

// Say at start-up (not at the first push) when a server has no working push provider.
if (!env.isTest) setImmediate(() => {
  try {
    getProvider();
  } catch (err) {
    logger.warn(`[push] ${err.message}`);
  }
});
