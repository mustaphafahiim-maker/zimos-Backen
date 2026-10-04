'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/**
 * Numeric limits of a store's plan (SPEC §17.4, the allowed part).
 *
 * A limit lives in the plan's features under `limits`:
 *
 *   plans.features = { "funnels": true, "limits": { "members": 5, "stores": 1 } }
 *
 * Billing itself (plans, prices, subscriptions) is not touched: this only
 * reads what the platform admin wrote on the plan. A key that is not there —
 * or a plan whose features are the older array form — means **unlimited**,
 * so nothing is restricted until someone decides a number.
 *
 * Keys in use: members, stores, domains, leads, storage_bytes, funnels_per_month,
 * bot_replies (the WhatsApp bot's replies this month).
 */

const LIMIT_KEYS = ['members', 'stores', 'domains', 'leads', 'storage_bytes', 'funnels_per_month', 'bot_replies'];

async function planOf(workspaceId) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    order: [['createdAt', 'DESC']],
    include: [{ model: db.Plan, as: 'plan', required: false }],
  });
  return subscription && subscription.plan ? subscription.plan : null;
}

/** The plan's number for `key`, or null for unlimited. */
async function limitFor(workspaceId, key) {
  const plan = await planOf(workspaceId);
  const features = plan ? plan.features : null;
  const limits = features && !Array.isArray(features) && typeof features === 'object' ? features.limits : null;
  const value = limits && Object.prototype.hasOwnProperty.call(limits, key) ? Number(limits[key]) : null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** How much of each limit the store uses now. One counter per key. */
const USAGE = {
  members: (workspaceId) => db.Membership.count({ where: { workspaceId, status: ['active', 'invited'] } }),
  domains: (workspaceId) => db.Domain.count({ where: { workspaceId } }),
  stores: async (workspaceId) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['ownerUserId'] });
    return workspace ? db.Workspace.count({ where: { ownerUserId: workspace.ownerUserId } }) : 0;
  },
  // New contacts collected by forms and the newsletter this calendar month (UTC, as usage_counters).
  leads: (workspaceId) => {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return db.Customer.count({ where: { workspaceId, source: ['form', 'newsletter'], createdAt: { [db.Sequelize.Op.gte]: from } } });
  },
  // The WhatsApp bot's replies this calendar month (UTC).
  bot_replies: (workspaceId) => {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return db.WhatsappMessage.count({ where: { workspaceId, sentByBot: true, status: { [db.Sequelize.Op.ne]: 'failed' }, createdAt: { [db.Sequelize.Op.gte]: from } } });
  },
  // Files the store keeps: the media library and digital products.
  storage_bytes: async (workspaceId) => {
    const [row] = await db.sequelize.query(
      `SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM media_assets WHERE workspace_id = :workspaceId)
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM digital_files WHERE workspace_id = :workspaceId) AS bytes`,
      { replacements: { workspaceId }, type: db.Sequelize.QueryTypes.SELECT }
    );
    return Number(row.bytes);
  },
};

async function usageFor(workspaceId, key) {
  return USAGE[key] ? USAGE[key](workspaceId) : null;
}

/**
 * Route guard: refuses with 402 PLAN_LIMIT_REACHED when the store already
 * uses all its plan allows of `key`. Put it on the route that adds one more
 * (invite a teammate, add a domain). No limit on the plan → always passes.
 */
function requirePlanLimit(key, { usage = null } = {}) {
  return async (req, res, next) => {
    try {
      const workspaceId = req.tenant.workspaceId;
      const limit = await limitFor(workspaceId, key);
      if (limit === null) return next();
      const used = usage ? await usage(req) : await usageFor(workspaceId, key);
      if (used !== null && used >= limit) {
        return next(new AppError('PLAN_LIMIT_REACHED', `Your plan allows ${limit} of this. Upgrade the plan to add more.`, 402, { limit: key, allowed: limit, used }));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { LIMIT_KEYS, limitFor, usageFor, requirePlanLimit, planOf };
