'use strict';

const env = require('../../../config/env');
const { AppError } = require('../../../core/errors/AppError');

/**
 * The Google Sheets adapter (README.md has the contract). Which one answers is
 * GOOGLE_SHEETS_PROVIDER; until the real Google adapter is registered the
 * sandbox answers — outside production only, like every other sandbox — and
 * keeps its spreadsheets as files on this machine.
 */
const REGISTRY = {
  // eslint-disable-next-line global-require
  sandbox: () => require('./sandbox'),
};

function getSheetsAdapter() {
  const wanted = (process.env.GOOGLE_SHEETS_PROVIDER || 'sandbox').trim();
  const load = REGISTRY[wanted];
  if (!load || (wanted === 'sandbox' && env.isProduction)) {
    throw new AppError('SHEETS_UNAVAILABLE', 'Google Sheets is not available yet', 503);
  }
  return load();
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
