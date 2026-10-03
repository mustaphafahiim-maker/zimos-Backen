'use strict';

const asyncHandler = require('express-async-handler');
const rateLimit = require('express-rate-limit');
const db = require('../../db/models');
const env = require('../../config/env');
const { AuthenticationError, RateLimitError } = require('../../core/errors/AppError');
const { SCOPES, findActiveKey, touchLastUsed } = require('./apiKeyService');

/**
 * The public API's stand-in for `authenticate` + `resolveTenant`.
 *
 * Reads the key from `Authorization: Bearer <key>` (or `X-API-Key`), and on
 * success leaves the request looking exactly like a staff request from the
 * key's creator — req.user, and req.tenant with the same shape resolveTenant
 * builds — so the route can use requirePermission and call the same services
 * the dashboard does. The one difference is req.tenant.hasPermission: the
 * creator's role AND the key's scopes (apiKeyService.SCOPES) must both allow
 * it. req.apiKey is the key row.
 *
 * Every failure is the same 401, whether the key is malformed, unknown,
 * revoked, its creator gone or its workspace suspended: an answer that
 * differed would tell a caller which of those it had guessed right.
 */

const INVALID = () => new AuthenticationError('Invalid API key', 'INVALID_API_KEY');

function readKey(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-api-key'];
  return typeof alt === 'string' ? alt.trim() : null;
}

const authenticateApiKey = asyncHandler(async (req, res, next) => {
  const raw = readKey(req);
  if (!raw) throw new AuthenticationError('Missing API key — send it as "Authorization: Bearer <key>"', 'INVALID_API_KEY');

  const key = await findActiveKey(raw);
  if (!key) throw INVALID();

  // A suspended or closed store's integrations stop with it.
  const workspace = await db.Workspace.findByPk(key.workspaceId, { attributes: ['id', 'status'] });
  if (!workspace || workspace.status !== 'active') throw INVALID();

  const user = await db.User.findByPk(key.createdByUserId);
  if (!user || user.status !== 'active') throw INVALID();

  const membership = await db.Membership.findOne({
    where: { workspaceId: key.workspaceId, userId: user.id, status: 'active' },
    include: [{ model: db.Role, as: 'role' }],
  });
  if (!membership) throw INVALID();

  const rolePermissions = membership.role.permissions;
  const scopePermissions = new Set(key.scopes.flatMap((scope) => SCOPES[scope] || []));

  req.user = user;
  req.apiKey = key;
  req.tenant = {
    workspaceId: key.workspaceId,
    membership,
    role: membership.role,
    hasPermission(permission) {
      const roleAllows = rolePermissions.includes('*') || rolePermissions.includes(permission);
      return roleAllows && scopePermissions.has(permission);
    },
  };

  await touchLastUsed(key);
  next();
});

/**
 * Each key's own rate limit (api_keys.rate_limit_per_minute), counted per
 * key rather than per IP — one integration server usually calls for many
 * stores from the same address. Built by a factory so a test can make one
 * that isn't skipped; the app's copy is skipped under NODE_ENV=test like
 * every limiter in core/middleware/rateLimiters.js.
 */
function createApiKeyLimiter({ skip = () => env.isTest } = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: (req) => req.apiKey.rateLimitPerMinute,
    keyGenerator: (req) => `api_key:${req.apiKey.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: (req, res, next) => next(new RateLimitError('Too many requests for this API key')),
  });
}

const apiKeyLimiter = createApiKeyLimiter();

module.exports = { authenticateApiKey, apiKeyLimiter, createApiKeyLimiter };
