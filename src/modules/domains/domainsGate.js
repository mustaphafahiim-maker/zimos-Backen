'use strict';

const env = require('../../config/env');
const { notFoundHandler } = require('../../core/middleware/errorHandler');

/** True only when CUSTOM_DOMAINS_ENABLED is exactly "true" (config/env.js `customDomains.enabled`). */
const customDomainsEnabled = () => env.customDomains.enabled === true;

/**
 * Off: every merchant domains route answers the app's 404 (ROUTE_NOT_FOUND),
 * like an unknown path, before any auth runs. Read per request.
 */
function requireCustomDomains(req, res, next) {
  return customDomainsEnabled() ? next() : notFoundHandler(req, res, next);
}

module.exports = { customDomainsEnabled, requireCustomDomains };
