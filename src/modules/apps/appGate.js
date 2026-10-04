'use strict';

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { AuthorizationError } = require('../../core/errors/AppError');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { BY_KEY } = require('./appCatalogue');

/**
 * Whether a store has an app switched on (SPEC §16.6 "features that have an
 * app check workspace_apps before running").
 *
 * A `standard` app (appCatalogue.js) is a feature every store has had from
 * the start: it is on until the store uninstalls it. Any other app is off
 * until it is installed. The answer is cached per store for a short while in
 * each process; install/uninstall clear this process's copy at once, other
 * processes (the worker) catch up within CACHE_MS.
 */

const CACHE_MS = 30 * 1000;
const MAX_ENTRIES = 5000;
const cache = new Map(); // workspaceId → { at, statuses: Map<appKey, status> }

async function statuses(workspaceId, transaction) {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.statuses;
  const rows = await db.WorkspaceApp.findAll({ where: { workspaceId, kind: 'catalogue' }, attributes: ['appKey', 'status'], transaction });
  const map = new Map(rows.map((row) => [row.appKey, row.status]));
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(workspaceId, { at: Date.now(), statuses: map });
  return map;
}

/** True when the app's feature may run for this store. `transaction` is used only on a cache miss. */
async function isEnabled(workspaceId, key, { transaction } = {}) {
  const status = (await statuses(workspaceId, transaction)).get(key);
  if (status) return status === 'installed';
  const entry = BY_KEY.get(key);
  return Boolean(entry && entry.standard);
}

function forget(workspaceId) {
  cache.delete(workspaceId);
}

function notInstalled(key) {
  const err = new AuthorizationError('Install this app from the app store first');
  err.code = 'APP_NOT_INSTALLED';
  err.details = { app: key };
  return err;
}

async function assertEnabled(workspaceId, key, options) {
  if (!(await isEnabled(workspaceId, key, options))) throw notInstalled(key);
}

// An outside company's app (the install link) brought its own key and webhooks:
// they keep working whatever the store does with the Public API and Webhooks apps.
const externalHolds = (where) => db.WorkspaceApp.count({ where: { ...where, kind: 'external', status: 'installed' } }).then((n) => n > 0);

/** Whether a public-API key may be used: the Public API app is on, or an installed outside app holds the key. */
async function apiKeyAllowed(key) {
  return (await isEnabled(key.workspaceId, 'public_api')) || externalHolds({ workspaceId: key.workspaceId, apiKeyId: key.id });
}

/** Whether a webhook endpoint may be sent to: the Webhooks app is on, or it belongs to an installed outside app. */
async function endpointAllowed(endpoint) {
  if (await isEnabled(endpoint.workspaceId, 'webhooks')) return true;
  return externalHolds({ workspaceId: endpoint.workspaceId, webhookEndpointIds: { [Op.contains]: [endpoint.id] } });
}

/**
 * Mounted in front of a feature's dashboard routes: creating and changing
 * need the app; reading and removing stay open, so a store that took the app
 * off still sees what it had set up and can clear it away. `except` lists
 * paths (relative to the mount) that only read although they are POSTs. The
 * caller is authenticated first, so only a member learns the app is off.
 */
function requireAppForChanges(key, { except = [] } = {}) {
  const check = asyncHandler(async (req, res, next) => {
    await assertEnabled(req.tenant.workspaceId, key);
    next();
  });
  const chain = [authenticate, resolveTenant, check];
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method) || except.includes(req.path)) return next();
    let i = 0;
    const step = (err) => (err ? next(err) : i < chain.length ? chain[i++](req, res, step) : next());
    return step();
  };
}

module.exports = { isEnabled, assertEnabled, forget, notInstalled, requireAppForChanges, apiKeyAllowed, endpointAllowed };
