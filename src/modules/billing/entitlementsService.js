'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { monthWindow } = require('../../core/utils/zonedMonth');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
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
  return FEATURE_CATALOG.map(({ key, type, available, label }) => {
    const inPlan = planKeys.has(key);
    const override = live.get(key);
    const applied = override && isApplied(override, now);
    return {
      key,
      type,
      // The catalogue's names and whether the feature exists today, for the console.
      available,
      label: { ...label },
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

// ---------------------------------------------------------------- limits

/**
 * Plan limits (migration 126), worked out here and nowhere else:
 *
 *   stores             how many stores one person may own. When they create
 *                      one, the limit is the largest max_stores among the
 *                      plans of their current stores and the plan chosen for
 *                      the new one — NULL on any of them is no limit. A
 *                      current store is one whose subscription has not ended
 *                      (a draft counts: it is on its chosen plan). Every
 *                      store they own counts towards the number, drafts
 *                      included; a closed one does not. Their first store is
 *                      never refused.
 *   funnels_per_month  how many funnels a store may make in a calendar month
 *                      in Africa/Cairo, created or duplicated, deleted ones
 *                      included (funnel_creations), on its own plan.
 *   draft_stores       while REQUIRE_SUBSCRIPTION_TO_GO_LIVE is on: someone
 *                      with no store out of draft may hold at most
 *                      DRAFT_STORES_PER_USER drafts.
 *
 * Limits only ever refuse a new store or funnel: nothing that exists is
 * deleted or switched off when a plan changes or its limits drop, and a
 * plan's new limits apply from the next creation. Each check and the insert
 * it guards run in one transaction under an advisory lock on the owner (or
 * the store), so two requests at once cannot both slip under the limit.
 *
 * Refusals are 403 PLAN_LIMIT_REACHED with { limit, max, used, … }.
 */


const LIMITS_TIME_ZONE = 'Africa/Cairo';
// A closed store frees its place; a suspended one does not.
const COUNTED_STORE_STATUSES = ['active', 'suspended'];

function planLimitReached(details, message) {
  return new AppError('PLAN_LIMIT_REACHED', message, 403, details);
}

/** Serialises creations for one key until the transaction ends. */
async function advisoryLock(key, transaction) {
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext($key))', { bind: { key }, transaction });
}

const draftsEnforced = () => env.signup.requireSubscription === true;

/** A subscription still running now: not cancelled and inside its period, or a draft. */
function isCurrent(subscription, now) {
  if (!subscription) return false;
  if (subscription.status === 'draft') return true;
  if (subscription.status === 'cancelled') return false;
  return new Date(subscription.currentPeriodEnd).getTime() > now.getTime();
}

/** The largest max_stores of `plans` (null = unlimited wins), and the plan it came from. */
function largestStoreLimit(plans) {
  let best = null;
  for (const plan of plans) {
    if (plan.maxStores === null || plan.maxStores === undefined) return { max: null, plan };
    if (!best || plan.maxStores > best.max) best = { max: plan.maxStores, plan };
  }
  return best || { max: null, plan: null };
}

async function ownedStores(ownerUserId, transaction) {
  return db.Workspace.findAll({
    where: { ownerUserId, status: COUNTED_STORE_STATUSES },
    attributes: ['id'],
    include: [
      {
        model: db.Subscription,
        as: 'subscription',
        attributes: ['id', 'status', 'currentPeriodEnd', 'planId'],
        include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'name', 'maxStores'] }],
      },
    ],
    transaction,
  });
}

/** { used, max, planName } for `ownerUserId`, with `candidatePlan` counted as one of their plans. */
async function storeAllowance(ownerUserId, candidatePlan, { now = new Date(), transaction } = {}) {
  const stores = await ownedStores(ownerUserId, transaction);
  const plans = stores
    .map((w) => w.subscription)
    .filter((s) => s && s.plan && isCurrent(s, now))
    .map((s) => s.plan);
  if (candidatePlan) plans.push(candidatePlan);
  const { max, plan } = largestStoreLimit(plans);
  const drafts = stores.filter((w) => w.subscription && w.subscription.status === 'draft').length;
  return { used: stores.length, max, planName: plan ? plan.name : null, drafts, live: stores.length - drafts };
}

/**
 * Inside the store-creation transaction, before the store is inserted:
 * refuses a store past the owner's limit (and, with drafts on, a draft past
 * DRAFT_STORES_PER_USER). Holds the owner's lock until the transaction ends.
 */
async function assertCanCreateStore(ownerUserId, chosenPlan, { transaction, now = new Date() }) {
  await advisoryLock(`plan-limits:stores:${ownerUserId}`, transaction);
  const allowance = await storeAllowance(ownerUserId, chosenPlan, { now, transaction });
  if (allowance.used === 0) return allowance;

  if (allowance.max !== null && allowance.used >= allowance.max) {
    throw planLimitReached(
      { limit: 'stores', max: allowance.max, used: allowance.used, planName: allowance.planName },
      'Your plan does not allow another store'
    );
  }
  if (draftsEnforced() && allowance.live === 0 && allowance.drafts >= env.signup.draftStoresPerUser) {
    throw planLimitReached(
      { limit: 'draft_stores', max: env.signup.draftStoresPerUser, used: allowance.drafts },
      'Subscribe to one of your stores before starting another'
    );
  }
  return allowance;
}

async function planOf(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id', 'planId'],
    include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'name', 'maxStores', 'maxFunnelsPerMonth'] }],
    transaction,
  });
  return subscription ? subscription.plan : null;
}

/** { used, max, resetsAt } for this store's funnels this Cairo month. */
async function funnelAllowance(workspaceId, { now = new Date(), transaction, plan } = {}) {
  const current = plan === undefined ? await planOf(workspaceId, transaction) : plan;
  const { start, resetsAt } = monthWindow(now, LIMITS_TIME_ZONE);
  const used = await db.FunnelCreation.count({
    where: { workspaceId, createdAt: { [db.Sequelize.Op.gte]: start, [db.Sequelize.Op.lt]: resetsAt } },
    transaction,
  });
  const max = current && current.maxFunnelsPerMonth !== null && current.maxFunnelsPerMonth !== undefined ? current.maxFunnelsPerMonth : null;
  return { used, max, resetsAt };
}

/**
 * Inside the funnel-creation transaction: refuses a funnel past the plan's
 * monthly limit, otherwise records the creation (`funnelId` is the new
 * funnel's, known before its insert). Holds the store's lock until the
 * transaction ends.
 */
async function recordFunnelCreation(workspaceId, funnelId, source, { transaction, now = new Date() }) {
  await advisoryLock(`plan-limits:funnels:${workspaceId}`, transaction);
  const allowance = await funnelAllowance(workspaceId, { now, transaction });
  if (allowance.max !== null && allowance.used >= allowance.max) {
    throw planLimitReached(
      { limit: 'funnels_per_month', max: allowance.max, used: allowance.used, resetsAt: allowance.resetsAt },
      'Your plan does not allow another funnel this month'
    );
  }
  await db.FunnelCreation.create({ workspaceId, funnelId, source }, { transaction });
  return allowance;
}

/**
 * What GET /workspaces/:id/billing (and the console's store page) show: this
 * store's owner against their store limit — as if they created one more on
 * this store's plan — and this store's funnels this month.
 */
async function getLimits(workspaceId, { now = new Date() } = {}) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'ownerUserId'] });
  if (!workspace) throw new NotFoundError('Workspace');
  const plan = await planOf(workspaceId);
  const stores = await storeAllowance(workspace.ownerUserId, plan, { now });
  const funnels = await funnelAllowance(workspaceId, { now, plan });
  return {
    stores: { used: stores.used, max: stores.max },
    funnelsThisMonth: { used: funnels.used, max: funnels.max, resetsAt: funnels.resetsAt },
  };
}

module.exports = {
  featureTable,
  effectiveFeatures,
  hasFeature,
  listForAdmin,
  addOverride,
  updateOverride,
  revokeOverride,
  LIMITS_TIME_ZONE,
  assertCanCreateStore,
  recordFunnelCreation,
  storeAllowance,
  funnelAllowance,
  getLimits,
};
