'use strict';

const env = require('../../config/env');

/** True only when AI_ENABLED is exactly "true" (config/env.js `ai.enabled`). */
const aiEnabled = () => env.ai.enabled === true;

/**
 * Mounts a router that exists only while AI is on. Off, the request goes on
 * as if the router were not there: the app's 404, like any unknown path.
 */
const whenAiEnabled = (router) => (req, res, next) => (aiEnabled() ? router(req, res, next) : next());

module.exports = { aiEnabled, whenAiEnabled };
