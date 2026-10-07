'use strict';

const env = require('../../../../config/env');
const { AppError } = require('../../../../core/errors/AppError');

/**
 * Which adapter sends a team channel's messages (README.md has the contract).
 * TEAM_CHANNELS_PROVIDER: `live` (the real Telegram, Slack and Discord APIs)
 * or `sandbox` (nothing leaves the server). Default: live in production,
 * sandbox elsewhere; the sandbox is never used in production.
 */
const LIVE = {
  // eslint-disable-next-line global-require
  telegram: () => require('./telegram'),
  // eslint-disable-next-line global-require
  slack: () => require('./slack'),
  // eslint-disable-next-line global-require
  discord: () => require('./discord'),
};

const mode = () => (process.env.TEAM_CHANNELS_PROVIDER || (env.isProduction ? 'live' : 'sandbox')).trim();

function getAdapter(provider) {
  const wanted = mode();
  // eslint-disable-next-line global-require
  if (wanted === 'sandbox' && !env.isProduction) return require('./sandbox');
  if (wanted === 'live' && LIVE[provider]) return LIVE[provider]();
  throw new AppError('TEAM_CHANNEL_UNAVAILABLE', 'Sending to team channels is not available yet', 503);
}

function describeAdapter() {
  const wanted = mode();
  if (wanted === 'sandbox' && !env.isProduction) return { available: true, sandbox: true };
  return { available: wanted === 'live', sandbox: false };
}

module.exports = { getAdapter, describeAdapter };
