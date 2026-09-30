'use strict';

const db = require('../../db/models');
const { ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { FEATURE_CATALOG, featureDefinition, planFeatureKeys } = require('./featureCatalog');

/**
 * A store's features, computed in one place: its plan's features
 * (plans.features, catalogue keys only) with the store's live overrides on
 * top — an override wins over the plan: 'grant' adds the feature, 'deny'
 * takes it away (`value` would replace a limit; the catalogue has none yet,
 * so it stays empty). An override past its expires_at no longer applies,
 * judged when read, no job. Revoked ones never apply.
 *
 * Nothing is cached, so a new or revoked override counts from the next read.
 * Today no route gates on these keys (the plan's features are descriptive);
 * this is where any gate should ask — effectiveFeatures / hasFeature — and the
 * merchant's billing summary (GET /workspaces/:id/billing) carries the result.
 */

function isApplied(override, now) {
  return !override.revokedAt && (!override.expiresAt || new Date(override.expiresAt) > now);
}

function serializeOverride(o, now = new Date()) {
  return {
    id: o.id,
    featureKey: o.featureKey,
    mode: o.mode,
    value: o.value,
    expiresAt: o.expiresAt,
    reason: o.reason,
    grantedBy: o.grantedByUser ? { id: o.grantedByUser.id, fullName: o.grantedByUser.fullName } : null,
    createdAt: o.createdAt,
    revokedAt: o.revokedAt,
    revokedBy: o.revokedByUser ? { id: o.revokedByUser.id, fullName: o.revokedByUser.fullName } : null,
    revokeReason: o.revokeReason,
    state: o.revokedAt ? 'revoked' : o.expiresAt && new Date(o.expiresAt) <= now ? 'expired' : 'active',
  };
}

const OVERRIDE_INCLUDE = [
  { model: db.User, as: 'grantedByUser', attributes: ['id', 'fullName'] },
  { model: db.User, as: 'revokedByUser', attributes: ['id', 'fullName'] },
];

async function planKeysFor(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'features'] }],
    transaction,
  });
  const keys = subscription && subscription.plan ? planFeatureKeys(subscription.plan.features) : [];
  return new Set(keys.filter((k) => featureDefinition(k)));
}

/**
 * Every catalogue feature for this store: enabled or not, and why —
 * source 'plan' | 'override' | 'none'; an override that ran out is listed as
 * `expiredOverride` next to what now applies.
 */
async function featureTable(workspaceId, { now = new Date(), transaction } = {}) {
  const planKeys = await planKeysFor(workspaceId, transaction);
  const overrides = await db.WorkspaceFeatureOverride.findAll({
    where: { workspaceId, revokedAt: null },
    include: OVERRIDE_INCLUDE,
    transaction,
  });
  const live = new Map(overrides.map((o) => [o.featureKey, o]));
  return FEATURE_CATALOG.map(({ key, type }) => {
    const inPlan = planKeys.has(key);
    const override = live.get(key);
    const applied = override && isApplied(override, now);
    return {
      key,
      type,
      inPlan,
      enabled: applied ? override.mode === 'grant' : inPlan,
      source: applied ? 'override' : inPlan ? 'plan' : 'none',
      override: applied ? serializeOverride(override, now) : null,
      expiredOverride: override && !applied ? serializeOverride(override, now) : null,
    };
  });
}

/** The keys this store has right now. */
async function effectiveFeatures(workspaceId, opts) {
  return (await featureTable(workspaceId, opts)).filter((f) => f.enabled).map((f) => f.key);
}

async function hasFeature(workspaceId, key, opts) {
  return (await effectiveFeatures(workspaceId, opts)).includes(key);
}

/** GET /admin/workspaces/:id/features */
async function listForAdmin(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'] });
  if (!workspace) throw new NotFoundError('Workspace');
  const now = new Date();
  const history = await db.WorkspaceFeatureOverride.findAll({
    where: { workspaceId },
    include: OVERRIDE_INCLUDE,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: 100,
  });
  return { features: await featureTable(workspaceId, { now }), overrides: history.map((o) => serializeOverride(o, now)) };
}

function checkDefinition(featureKey, value) {
  const definition = featureDefinition(featureKey);
  if (!definition) {
    throw new ValidationError([{ field: 'featureKey', message: 'Not a feature in the catalogue' }], 'Not a feature in the catalogue');
  }
  if (definition.type === 'boolean' && value !== undefined && value !== null) {
    throw new ValidationError([{ field: 'value', message: 'This feature is on/off and takes no value' }], 'This feature takes no value');
  }
}

function checkExpiry(expiresAt) {
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw new ValidationError([{ field: 'expiresAt', message: 'The expiry must be in the future' }], 'The expiry must be in the future');
  }
}

async function audit(req, action, workspaceId, override, before, transaction) {
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action,
    entityType: 'WorkspaceFeatureOverride',
    entityId: override.id,
    before,
    after: serializeOverride(override),
    metadata: { featureKey: override.featureKey },
    req,
    transaction,
  });
}

/**
 * POST /admin/workspaces/:id/feature-overrides. One live override per key: a
 * live one that has only expired is revoked and replaced; a live one still
 * applying is a 409 (edit or revoke it instead).
 */
async function addOverride(workspaceId, { featureKey, mode, value = null, expiresAt = null, reason }, req) {
  checkDefinition(featureKey, value);
  checkExpiry(expiresAt);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'] });
  if (!workspace) throw new NotFoundError('Workspace');

  return db.sequelize.transaction(async (transaction) => {
    const now = new Date();
    const existing = await db.WorkspaceFeatureOverride.findOne({
      where: { workspaceId, featureKey, revokedAt: null },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing && isApplied(existing, now)) {
      throw new ConflictError('This store already has an override for this feature — edit or revoke it', 'FEATURE_OVERRIDE_EXISTS');
    }
    if (existing) {
      await existing.update({ revokedAt: now, revokedBy: req.user.id, revokeReason: 'Replaced after it expired' }, { transaction });
    }
    const override = await db.WorkspaceFeatureOverride.create(
      { workspaceId, featureKey, mode, value, expiresAt, reason, grantedBy: req.user.id },
      { transaction }
    );
    await audit(req, 'workspace.feature_override.add', workspaceId, override, null, transaction);
    return serializeOverride(override, now);
  });
}

async function loadLive(workspaceId, overrideId, transaction) {
  const override = await db.WorkspaceFeatureOverride.findOne({
    where: { id: overrideId, workspaceId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!override) throw new NotFoundError('Feature override');
  if (override.revokedAt) throw new ConflictError('This override was revoked', 'FEATURE_OVERRIDE_REVOKED');
  return override;
}

/** PATCH …/feature-overrides/:overrideId — mode, expiry and reason. */
async function updateOverride(workspaceId, overrideId, patch, req) {
  if (patch.expiresAt) checkExpiry(patch.expiresAt);
  return db.sequelize.transaction(async (transaction) => {
    const override = await loadLive(workspaceId, overrideId, transaction);
    checkDefinition(override.featureKey, patch.value);
    const before = serializeOverride(override);
    const next = {};
    for (const key of ['mode', 'expiresAt', 'reason', 'value']) if (patch[key] !== undefined) next[key] = patch[key];
    await override.update(next, { transaction });
    await audit(req, 'workspace.feature_override.update', workspaceId, override, before, transaction);
    return serializeOverride(override);
  });
}

/** POST …/feature-overrides/:overrideId/revoke — the plan decides again. */
async function revokeOverride(workspaceId, overrideId, { reason = null } = {}, req) {
  return db.sequelize.transaction(async (transaction) => {
    const override = await loadLive(workspaceId, overrideId, transaction);
    const before = serializeOverride(override);
    await override.update({ revokedAt: new Date(), revokedBy: req.user.id, revokeReason: reason }, { transaction });
    await audit(req, 'workspace.feature_override.revoke', workspaceId, override, before, transaction);
    return serializeOverride(override);
  });
}

module.exports = {
  featureTable,
  effectiveFeatures,
  hasFeature,
  listForAdmin,
  addOverride,
  updateOverride,
  revokeOverride,
};
