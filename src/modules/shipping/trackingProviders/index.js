'use strict';

const env = require('../../../config/env');
const featureFlags = require('../../../core/utils/featureFlags');
const sandbox = require('./sandbox');
const aftership = require('./aftership');

/**
 * Tracking providers for manual and imported waybills (item 387). The
 * contract is in providerContract.js and README.md; adding one is a file here
 * and a line in PROVIDERS.
 *
 * The sandbox exists outside production for every store; in production only
 * with TRACKING_SANDBOX=true and for stores whose FeatureFlag
 * `sandbox_integrations` is on (as the sandbox courier).
 */

const PROVIDERS = new Map([sandbox, aftership].map((p) => [p.code, p]));

const getProvider = (code) => PROVIDERS.get(code) || null;

async function availableFor(provider, workspaceId) {
  if (!provider || !provider.configured()) return false;
  if (!provider.isSandbox) return true;
  if (!env.isProduction) return true;
  return process.env.TRACKING_SANDBOX === 'true' && featureFlags.isOn('sandbox_integrations', workspaceId);
}

/** Every provider, with whether this store may pick it. */
async function listFor(workspaceId) {
  const out = [];
  for (const provider of PROVIDERS.values()) {
    out.push({
      code: provider.code,
      name: provider.name,
      sandbox: provider.isSandbox,
      available: await availableFor(provider, workspaceId),
    });
  }
  return out;
}

/** The provider for a code, if this store may use it; else null. */
async function providerFor(code, workspaceId) {
  const provider = getProvider(code);
  return provider && (await availableFor(provider, workspaceId)) ? provider : null;
}

module.exports = { getProvider, providerFor, listFor, availableFor, PROVIDER_CODES: [...PROVIDERS.keys()] };
