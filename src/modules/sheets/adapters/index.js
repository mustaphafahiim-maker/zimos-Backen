'use strict';

const env = require('../../../config/env');
const { AppError } = require('../../../core/errors/AppError');

/**
 * The Google Sheets adapter (README.md has the contract). Which one answers is
 * GOOGLE_SHEETS_PROVIDER: `sandbox` (the default, outside production only,
 * like every other sandbox; it keeps its spreadsheets as files on this
 * machine) or `google`, which is unavailable until its client id, secret and
 * redirect URI are set.
 */
const REGISTRY = {
  // eslint-disable-next-line global-require
  sandbox: () => require('./sandbox'),
  // eslint-disable-next-line global-require
  google: () => require('./google'),
};

function getSheetsAdapter() {
  const wanted = (process.env.GOOGLE_SHEETS_PROVIDER || 'sandbox').trim();
  const load = REGISTRY[wanted];
  if (!load || (wanted === 'sandbox' && env.isProduction)) {
    throw new AppError('SHEETS_UNAVAILABLE', 'Google Sheets is not available yet', 503);
  }
  const adapter = load();
  if (adapter.isConfigured && !adapter.isConfigured()) {
    throw new AppError('SHEETS_UNAVAILABLE', 'Google Sheets is not available yet', 503);
  }
  return adapter;
}

function describeAdapter() {
  try {
    const adapter = getSheetsAdapter();
    return { available: true, name: adapter.name, sandbox: Boolean(adapter.sandbox) };
  } catch {
    return { available: false, name: null, sandbox: false };
  }
}

module.exports = { getSheetsAdapter, describeAdapter };
