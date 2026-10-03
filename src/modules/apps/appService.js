'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError, AuthorizationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const outbox = require('../../core/outbox/outbox');
const { CATEGORIES, APPS, BY_KEY } = require('./appCatalogue');

/**
 * The store's side of the app store (SPEC §16.6): what can be installed, what
 * is installed, install and uninstall. A feature that is an app asks
 * `isInstalled` (or mounts `requireApp(key)`) before it runs.
 */

const sandboxAllowed = () => !env.isProduction;

let synced = null;
/** Makes sure every catalogue entry has its `apps` row. Once per process. */
function ensureCatalogue() {
  if (!synced) {
    synced = (async () => {
      const existing = new Set((await db.App.findAll({ attributes: ['key'] })).map((row) => row.key));
      const missing = APPS.filter((entry) => !existing.has(entry.key));
      if (missing.length > 0) {
        await db.App.bulkCreate(
          missing.map((entry) => ({ key: entry.key, category: entry.category, kind: entry.kind, displayOrder: APPS.indexOf(entry) })),
          { ignoreDuplicates: true }
        );
      }
    })().catch((err) => {
      synced = null;
      throw err;
    });
  }
  return synced;
}

const priceOf = (row) =>
  row && row.priceAmount !== null && row.priceAmount !== undefined
    ? { amount: String(row.priceAmount), currency: row.currency, billing: row.billing }
    : null;

function externalView(row) {
  const external = row.external || {};
  return {
    id: row.id,
    name: external.name,
    description: external.description || null,
    icon: external.icon || null,
    scopes: external.scopes || [],
    webhooks: (row.webhookEndpointIds || []).length,
    installedAt: row.installedAt,
  };
}

async function listApps(workspaceId) {
  await ensureCatalogue();
  const [rows, installs] = await Promise.all([
    db.App.findAll({ order: [['displayOrder', 'ASC']] }),
    db.WorkspaceApp.findAll({ where: { workspaceId, status: 'installed' } }),
  ]);
  const installedByKey = new Map(installs.filter((i) => i.appKey).map((i) => [i.appKey, i]));
  const apps = [];
  for (const row of rows) {
    const entry = BY_KEY.get(row.key);
    if (!entry || !row.isActive) continue;
    if (entry.sandbox && !sandboxAllowed()) continue;
    const install = installedByKey.get(row.key);
    apps.push({
      key: entry.key,
      category: row.category,
      kind: row.kind,
      name: entry.name,
      description: entry.description,
      availability: entry.availability,
      isTest: Boolean(entry.sandbox),
      openPath: entry.openPath || null,
      price: priceOf(row),
      installed: Boolean(install),
      installedAt: install ? install.installedAt : null,
      renewsAt: install ? install.renewsAt : null,
    });
  }
  return {
    categories: CATEGORIES,
    apps,
    external: installs.filter((i) => i.kind === 'external').map(externalView),
  };
}

function entryOrThrow(key) {
  const entry = BY_KEY.get(key);
  if (!entry || (entry.sandbox && !sandboxAllowed())) throw new NotFoundError('App');
  return entry;
}

async function install(workspaceId, key, req) {
  const entry = entryOrThrow(key);
  await ensureCatalogue();
  const row = await db.App.findOne({ where: { key } });
  if (!row || !row.isActive) throw new NotFoundError('App');
  if (entry.availability !== 'available') throw new AppError('APP_NOT_AVAILABLE', 'This app is not available yet', 409);

  const [record, created] = await db.WorkspaceApp.findOrCreate({
    where: { workspaceId, appKey: key },
    defaults: { workspaceId, appKey: key, kind: 'catalogue', status: 'installed', installedByUserId: req.user.id },
  });
  if (!created && record.status !== 'installed') {
    await record.update({ status: 'installed', installedAt: new Date(), uninstalledAt: null, installedByUserId: req.user.id });
  }
  if (created || record.changed) {
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'app.install', entityType: 'WorkspaceApp', entityId: record.id, after: { key }, req });
  }
  return { key, installed: true, installedAt: record.installedAt, openPath: entry.openPath || null };
}

async function uninstall(workspaceId, key, req) {
  entryOrThrow(key);
  const record = await db.WorkspaceApp.findOne({ where: { workspaceId, appKey: key, status: 'installed' } });
  if (!record) return { key, installed: false };
  await db.sequelize.transaction(async (transaction) => {
    await record.update({ status: 'uninstalled', uninstalledAt: new Date() }, { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'app.uninstall', entityType: 'WorkspaceApp', entityId: record.id, before: { key }, req, transaction });
    await outbox.record(transaction, 'app.uninstalled', { workspaceId, appKey: key }, { aggregateType: 'app', aggregateId: key });
  });
  return { key, installed: false };
}

async function isInstalled(workspaceId, key) {
  const record = await db.WorkspaceApp.findOne({ where: { workspaceId, appKey: key, status: 'installed' }, attributes: ['id'] });
  return Boolean(record);
}

/** Route guard for a feature that is an app: 403 APP_NOT_INSTALLED until the store installs it. */
function requireApp(key) {
  return async (req, res, next) => {
    try {
      if (await isInstalled(req.tenant.workspaceId, key)) return next();
      const err = new AuthorizationError('Install this app from the app store first');
      err.code = 'APP_NOT_INSTALLED';
      err.details = { app: key };
      return next(err);
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { listApps, install, uninstall, isInstalled, requireApp, ensureCatalogue, externalView, sandboxAllowed };
