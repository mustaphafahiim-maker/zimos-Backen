'use strict';

/**
 * Sandbox: no Google. The "token" is `sandbox:<email>:<subject>:<nonce>`, so the flow
 * can be tried without a Google client. Never used in production
 * (SHOPPER_GOOGLE_MODE=sandbox is refused there).
 */
async function verify(idToken) {
  const m = /^sandbox:([^:]+@[^:]+):([^:]+)(?::(.+))?$/.exec(String(idToken || ''));
  if (!m) throw new Error('Not a sandbox token');
  return { subject: m[2], email: m[1].toLowerCase(), emailVerified: true, name: null, nonce: m[3] || null };
}

module.exports = { name: 'sandbox', verify };
