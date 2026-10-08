'use strict';

const env = require('../../../config/env');
const { AppError } = require('../../../core/errors/AppError');

/**
 * Which AI provider answers (contract: ../README.md).
 *
 *   AI_PROVIDER set      → that one (`anthropic` or `sandbox`).
 *   else a key is set    → `anthropic` (ANTHROPIC_API_KEY), except under NODE_ENV=test,
 *                          so a developer's key never turns test runs into paid calls.
 *   else                 → the sandbox outside production; 503 AI_NOT_CONFIGURED in it.
 */
const REGISTRY = {
  // eslint-disable-next-line global-require
  sandbox: () => require('./sandbox'),
  // eslint-disable-next-line global-require
  anthropic: () => require('./anthropic'),
};

function wanted() {
  const explicit = (process.env.AI_PROVIDER || '').trim();
  if (explicit) return explicit;
  if ((process.env.ANTHROPIC_API_KEY || '').trim() && process.env.NODE_ENV !== 'test') return 'anthropic';
  return 'sandbox';
}

function getProvider() {
  const name = wanted();
  const load = REGISTRY[name];
  if (!load) throw new AppError('AI_NOT_CONFIGURED', `Unknown AI provider "${name}"`, 503);
  if (name === 'sandbox' && env.isProduction) {
    throw new AppError('AI_NOT_CONFIGURED', 'AI features are not available yet', 503);
  }
  const provider = load();
  if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
    throw new AppError('AI_NOT_CONFIGURED', 'AI features are not available yet', 503);
  }
  return provider;
}

/** For the dashboard: is AI usable here, and is it the test provider? */
function describeProvider() {
  try {
    const provider = getProvider();
    return { available: true, name: provider.name, sandbox: typeof provider.isSandbox === 'function' && provider.isSandbox() };
  } catch (err) {
    return { available: false, name: null, sandbox: false };
  }
}

module.exports = { getProvider, describeProvider };
