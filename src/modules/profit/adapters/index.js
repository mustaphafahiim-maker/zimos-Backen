'use strict';

const sandbox = require('./sandboxAdapter');

// provider code (WorkspaceIntegration.provider = `ads:<code>`) -> adapter.
const ADAPTERS = { sandbox };

function getAdsAdapter(code) {
  return ADAPTERS[code] || null;
}

module.exports = { getAdsAdapter, ADS_ADAPTER_CODES: Object.keys(ADAPTERS) };
