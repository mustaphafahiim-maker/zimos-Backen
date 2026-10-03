'use strict';

const env = require('../../../config/env');
const { AppError } = require('../../../core/errors/AppError');

/**
 * Which AI provider answers. The real provider is an open decision (SPEC §19):
 * the integrations team adds a file here that implements ../README.md and
 * registers it below. Until then the sandbox answers — outside production
 * only, like every other sandbox adapter.
 */
const REGISTRY = {
  // eslint-disable-next-line global-require
  sandbox: () => require('./sandbox'),
};

function getProvider() {
  const wanted = (process.env.AI_PROVIDER || 'sandbox').trim();
  const load = REGISTRY[wanted];
  if (!load) throw new AppError('AI_NOT_CONFIGURED', `Unknown AI provider "${wanted}"`, 503);
  if (wanted === 'sandbox' && env.isProduction) {
    throw new AppError('AI_NOT_CONFIGURED', 'AI features are not available yet', 503);
  }
  return load();
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
