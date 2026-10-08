'use strict';

const Joi = require('joi');
const db = require('../../../db/models');
const { NotFoundError, ValidationError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const providers = require('./index');

/**
 * The store setting `tracking_provider = { enabled, provider }` in
 * workspaces.settings: whether manual and imported waybills are followed
 * through a tracking provider, and which one.
 * GET/PUT /shipping/tracking-provider (shipping.manage).
 */

const KEY = 'tracking_provider';

function read(settings) {
  const raw = settings && typeof settings[KEY] === 'object' && settings[KEY] ? settings[KEY] : {};
  return {
    enabled: raw.enabled === true,
    provider: typeof raw.provider === 'string' && providers.PROVIDER_CODES.includes(raw.provider) ? raw.provider : null,
  };
}

const num = (name, fallback, min) => Math.max(min, parseInt(process.env[name] || '', 10) || fallback);

/** How the tracking job reads (environment; the same for every store). */
function polling() {
  return {
    intervalMinutes: num('TRACKING_POLL_INTERVAL_MINUTES', 60, 5),
    maxAgeDays: num('TRACKING_POLL_MAX_AGE_DAYS', 45, 1),
    perStoreBatch: num('TRACKING_POLL_PER_STORE', 50, 1),
    batchSize: num('TRACKING_POLL_BATCH', 500, 1),
  };
}

/** The provider a store's manual shipments are followed with now, or null (off, or not available). */
async function activeProvider(workspaceId, settings) {
  let s = settings;
  if (s === undefined) {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
    s = workspace ? workspace.settings : null;
  }
  const setting = read(s);
  if (!setting.enabled || !setting.provider) return null;
  return providers.providerFor(setting.provider, workspaceId);
}

async function view(workspaceId, settings) {
  const { intervalMinutes, maxAgeDays } = polling();
  return {
    trackingProvider: read(settings),
    providers: await providers.listFor(workspaceId),
    polling: { intervalMinutes, maxAgeDays },
  };
}

/** GET /shipping/tracking-provider */
async function getSetting(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  if (!workspace) throw new NotFoundError('Workspace');
  return view(workspaceId, workspace.settings);
}

const schemas = {
  get: { params: Joi.object({ workspaceId: Joi.string().uuid().required() }) },
  put: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    body: Joi.object({
      enabled: Joi.boolean().strict().required(),
      provider: Joi.string().valid(...providers.PROVIDER_CODES).allow(null),
    }),
  },
};

/** PUT /shipping/tracking-provider — { enabled, provider }. */
async function putSetting(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = read(workspace.settings);
    const provider = body.provider === undefined ? before.provider : body.provider;

    if (body.enabled && !provider) {
      throw new ValidationError([{ field: 'provider', message: 'Choose a tracking provider to switch tracking on' }], 'Invalid body');
    }
    if (provider && !(await providers.providerFor(provider, workspaceId))) {
      throw new ValidationError([{ field: 'provider', message: `"${provider}" is not available on this server for this store` }], 'Invalid body');
    }

    const after = { enabled: body.enabled, provider: provider || null };
    workspace.settings = { ...(workspace.settings || {}), [KEY]: after };
    workspace.changed('settings', true);
    await workspace.save({ transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipping.tracking_provider_update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before,
      after,
      req,
      transaction,
    });
    return view(workspaceId, workspace.settings);
  });
}

module.exports = { KEY, read, polling, activeProvider, getSetting, putSetting, schemas };
