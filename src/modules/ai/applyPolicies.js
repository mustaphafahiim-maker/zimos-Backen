'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { scoped } = require('../../core/utils/scopedRepository');

/**
 * "Store policies" with AI (SPEC §19.2) applied to the store's own policies
 * (SPEC §8.3, storefront/storeInfo.js `settings.legal`) instead of being
 * copied by hand. A `policies` generation — or a store builder's, whose
 * output carries the same three — writes:
 *
 *   shipping → legal.shipping_policy
 *   returns  → legal.refund_policy
 *   privacy  → legal.privacy_policy
 *
 * Only the ones asked for; terms of service are never touched. A policy the
 * store already has is replaced (the dashboard says which before asking),
 * and the answer names what was written and what it replaced. Can be done
 * again: the job stays as it was.
 *
 *   POST /ai/jobs/:jobId/apply-policies   { policies?: ['shipping','returns','privacy'] }
 */

const TARGET = { shipping: 'shipping_policy', returns: 'refund_policy', privacy: 'privacy_policy' };
const ALL = Object.keys(TARGET);

function policiesOf(job) {
  if (job.feature === 'policies') return job.output;
  if (job.feature === 'store_builder') return job.output && job.output.policies;
  return null;
}

async function applyPolicies(workspaceId, jobId, { policies = ALL } = {}, req) {
  const job = await scoped(db.AiJob, workspaceId, 'AI job').findByPkOrThrow(jobId);
  if (job.status !== 'succeeded') throw new AppError('AI_JOB_NOT_READY', 'This generation has no result to apply', 409);
  const texts = policiesOf(job);
  if (!texts) throw new AppError('AI_NOTHING_TO_APPLY', 'This result has no policies', 422);

  const wanted = [...new Set(policies)].filter((p) => typeof texts[p] === 'string' && texts[p].trim());
  if (wanted.length === 0) throw new AppError('AI_NOTHING_TO_APPLY', 'None of these policies is in the result', 422);

  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const settings = { ...(workspace.settings || {}) };
    const legal = { ...(settings.legal || {}) };
    const before = {};
    const replaced = [];
    for (const p of wanted) {
      const key = TARGET[p];
      before[key] = legal[key] || null;
      if (typeof legal[key] === 'string' && legal[key].trim()) replaced.push(key);
      legal[key] = texts[p].trim().slice(0, 30000);
    }
    settings.legal = legal;
    workspace.settings = settings;
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'ai.apply_policies',
      entityType: 'AiJob',
      entityId: job.id,
      before,
      after: { written: wanted.map((p) => TARGET[p]), replaced },
      req,
      transaction,
    });
    return { written: wanted.map((p) => TARGET[p]), replaced };
  });
}

module.exports = { TARGET, applyPolicies };
