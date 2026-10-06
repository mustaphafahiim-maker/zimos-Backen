'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const outbox = require('../../core/outbox/outbox');
const { CATEGORIES, APPS, BY_KEY } = require('./appCatalogue');
const gate = require('./appGate');

/**
 * The store's side of the app store (SPEC §16.6): what can be installed, what
 * is installed, install and uninstall. A feature that is an app asks
 * appGate.js before it runs; a `standard` app counts as installed until the
 * store uninstalls it.
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
  const [rows, records] = await Promise.all([
    db.App.findAll({ order: [['displayOrder', 'ASC']] }),
    db.WorkspaceApp.findAll({ where: { workspaceId } }),
  ]);
  const installs = records.filter((i) => i.status === 'installed');
  const recordByKey = new Map(records.filter((i) => i.appKey).map((i) => [i.appKey, i]));
  const apps = [];
  for (const row of rows) {
    const entry = BY_KEY.get(row.key);
    if (!entry || !row.isActive) continue;
    if (entry.sandbox && !sandboxAllowed()) continue;
    const record = recordByKey.get(row.key);
    const install = record && record.status === 'installed' ? record : null;
    const installed = record ? Boolean(install) : Boolean(entry.standard);
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
      installed,
      standard: Boolean(entry.standard),
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
  gate.forget(workspaceId);
  return { key, installed: true, installedAt: record.installedAt, openPath: entry.openPath || null };
}

async function uninstall(workspaceId, key, req) {
  const entry = entryOrThrow(key);
  let record = await db.WorkspaceApp.findOne({ where: { workspaceId, appKey: key } });
  if (record ? record.status !== 'installed' : !entry.standard) return { key, installed: false };
  await db.sequelize.transaction(async (transaction) => {
    if (record) await record.update({ status: 'uninstalled', uninstalledAt: new Date() }, { transaction });
    // A standard app the store never touched has no row yet: this one records that it was taken off.
    else record = await db.WorkspaceApp.create({ workspaceId, appKey: key, kind: 'catalogue', status: 'uninstalled', uninstalledAt: new Date() }, { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'app.uninstall', entityType: 'WorkspaceApp', entityId: record.id, before: { key }, req, transaction });
    await outbox.record(transaction, 'app.uninstalled', { workspaceId, appKey: key }, { aggregateType: 'app', aggregateId: key });
  });
  gate.forget(workspaceId);
  return { key, installed: false };
}

const isInstalled = (workspaceId, key) => gate.isEnabled(workspaceId, key);

/** Route guard for a feature that is an app: 403 APP_NOT_INSTALLED while the store does not have it. */
function requireApp(key) {
  return (req, res, next) => gate.assertEnabled(req.tenant.workspaceId, key).then(() => next(), next);
}

module.exports = { listApps, install, uninstall, isInstalled, requireApp, ensureCatalogue, externalView, sandboxAllowed };
