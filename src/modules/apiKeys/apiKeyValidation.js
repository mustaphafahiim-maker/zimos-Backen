'use strict';

const Joi = require('joi');
const env = require('../../config/env');
const { SCOPE_NAMES } = require('./apiKeyService');

const uuid = Joi.string().uuid();
const workspaceParam = { workspaceId: uuid.required() };

module.exports = {
  list: { params: Joi.object(workspaceParam) },
  create: {
    params: Joi.object(workspaceParam),
    body: Joi.object({
      name: Joi.string().trim().min(1).max(150).required(),
      scopes: Joi.array()
        .items(Joi.string().valid(...SCOPE_NAMES))
        .min(1)
        .required(),
      // Capped at the general per-IP limit (RATE_LIMIT_MAX): every request
      // also passes that one, so a higher key limit would be a promise the
      // server cannot keep.
      rateLimitPerMinute: Joi.number().integer().min(1).max(env.rateLimit.max).default(Math.min(60, env.rateLimit.max)),
    }),
  },
  revoke: { params: Joi.object({ ...workspaceParam, keyId: uuid.required() }) },
};
