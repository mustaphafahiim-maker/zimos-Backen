'use strict';

const crypto = require('crypto');

/**
 * The sandbox gateway's card setup: a card saved with no payment
 * (../savedMethods/README.md, "Saving a card without a payment"). Its hosted
 * page (../sandboxSetupRoutes.js) has a Save card and a Cancel button; the
 * answer comes back on the redirect, signed with the account's own secret.
 * Spread into sandbox.js's exports. No card, no money.
 */

const hmacHex = (secret, text) => crypto.createHmac('sha256', String(secret)).update(text).digest('hex');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Signature of the link to the setup page: its return address cannot be swapped. */
function signSetupPage(creds, workspaceId, reference, returnUrl) {
  return hmacHex(creds.signingSecret, `setup|${workspaceId}|${reference}|${returnUrl}`);
}

async function createCardSetup(creds, { workspaceId, reference, returnUrl, webhookUrl }) {
  // The page lives on this API, like the sandbox payment page.
  const base = String(webhookUrl).split('/webhooks/payments/')[0];
  const sig = signSetupPage(creds, workspaceId, reference, returnUrl);
  return {
    redirectUrl: `${base}/sandbox-pay/setup/${encodeURIComponent(workspaceId)}/${encodeURIComponent(reference)}?ret=${encodeURIComponent(returnUrl)}&sig=${sig}`,
  };
}

/** The signed fields the setup page sends back on the redirect. */
function buildSetupResult(creds, { reference, status }) {
  return { sbx_setup: reference, sbx_setup_status: status, sbx_setup_sig: hmacHex(creds.signingSecret, `setup-result|${reference}|${status}`) };
}

/** The saved card's token (the same shape sandbox.tokenize issues), or null when the shopper cancelled. */
async function completeCardSetup(creds, { reference, query }) {
  const flat = {};
  for (const [key, value] of Object.entries(query || {})) flat[key] = Array.isArray(value) ? value[0] : value;
  if (flat.sbx_setup !== reference) return null;
  const expected = hmacHex(creds.signingSecret, `setup-result|${reference}|${flat.sbx_setup_status}`);
  if (!safeEqualHex(expected, typeof flat.sbx_setup_sig === 'string' ? flat.sbx_setup_sig : '')) return null;
  if (flat.sbx_setup_status !== 'saved') return null;
  const id = crypto.randomBytes(12).toString('hex');
  return {
    token: `sbxtok.${id}.${hmacHex(creds.signingSecret, `token|${id}`)}`,
    brand: 'Sandbox',
    last4: '4242',
    expiresAt: new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000),
  };
}

module.exports = { createCardSetup, completeCardSetup, signSetupPage, buildSetupResult };
