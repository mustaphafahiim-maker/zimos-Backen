'use strict';

const env = require('../../config/env');
const { notFoundHandler } = require('../../core/middleware/errorHandler');

/**
 * Whether merchant custom domains are open (config/env.js `customDomains.enabled`,
 * item 341, Ziad's 08d23b2): unset, open as before; set, only exactly "true" opens.
 */
const customDomainsEnabled = () => env.customDomains.enabled === true;

/**
 * Closed: every merchant domains route answers the app's 404 (ROUTE_NOT_FOUND),
 * like an unknown path, before any auth runs. Read per request.
 */
function requireCustomDomains(req, res, next) {
  return customDomainsEnabled() ? next() : notFoundHandler(req, res, next);
}

module.exports = { customDomainsEnabled, requireCustomDomains };
