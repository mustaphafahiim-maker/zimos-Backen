'use strict';

const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const { AppError } = require('../../../core/errors/AppError');
const { aiEnabled } = require('../aiGate');

/**
 * Which AI provider answers. No real provider exists yet: the integrations
 * team adds a file here that implements ../README.md and registers it below.
 *
 * Nothing answers while AI_ENABLED is off. AI_PROVIDER names the provider;
 * empty means the sandbox outside production and none in production. The
 * sandbox runs in production only when AI_PROVIDER=sandbox is set there on
 * purpose, and says so in the log.
 */
const REGISTRY = {
  // eslint-disable-next-line global-require
  sandbox: () => require('./sandbox'),
};

let warnedSandboxInProduction = false;

function getProvider() {
  if (!aiEnabled()) throw new AppError('AI_DISABLED', 'AI features are not available', 404);
  const named = env.ai.provider;
  if (!named && env.isProduction) throw new AppError('AI_NOT_CONFIGURED', 'AI features are not available yet', 503);
  const wanted = named || 'sandbox';
  const load = REGISTRY[wanted];
  if (!load) throw new AppError('AI_NOT_CONFIGURED', `Unknown AI provider "${wanted}"`, 503);
  if (wanted === 'sandbox' && env.isProduction && !warnedSandboxInProduction) {
    warnedSandboxInProduction = true;
    logger.warn('[ai] AI_PROVIDER=sandbox in production: answers are canned test texts, not a real model');
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
