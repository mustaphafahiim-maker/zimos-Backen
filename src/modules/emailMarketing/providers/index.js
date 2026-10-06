'use strict';

const env = require('../../../config/env');

/** The email-marketing services a store can send its contacts to (README.md). */
const providers = new Map();
const register = (p) => providers.set(p.code, p);

/* eslint-disable global-require */
register(require('./mailchimp'));
register(require('./klaviyo'));
if (!env.isProduction) register(require('./sandbox'));
/* eslint-enable global-require */

module.exports = { get: (code) => providers.get(code) || null, list: () => [...providers.values()], register };
