'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const riskService = require('./riskService');
const { aiEnabled } = require('../ai/aiGate');

/**
 * The AI check of moderate-risk orders (SPEC §5.5, "Spam Shield", P2).
 *
 * Behind the FeatureFlag `ai_spam_shield`. A storefront order scored
 * `moderate` gets a job on the `ai` queue after it is saved — the order is
 * never delayed. The job sends the name, the address and the notes (never the
 * phone, the email or the IP) to the AI provider, which answers
 * `{ is_gibberish, is_abusive, address_complete }`; each finding adds points
 * to the order's risk score and a reason.
 *
 * The provider is the AI module's (modules/ai/providers): feature
 * `order_check`, contract in modules/ai/README.md. With no provider
 * configured the job ends quietly. While AI_ENABLED is off nothing is queued
 * and a queued job does nothing.
 */

const FLAG_KEY = 'ai_spam_shield';
const JOB_NAME = 'risk.ai_order_check';
const POINTS = Object.freeze({ ai_gibberish: 20, ai_abusive: 20, ai_incomplete_address: 15 });

const PROMPT = `You review one cash-on-delivery order placed in an online store in the Arab world.
You are given the customer's name, the delivery address and the order notes.
Answer with JSON only: {"is_gibberish": boolean, "is_abusive": boolean, "address_complete": boolean}.
- is_gibberish: the name or the address is random characters, keyboard mashing or obviously not a real name or place.
- is_abusive: any of the three contains insults or obscene words, in Arabic or English.
- address_complete: a courier could find the address (it names at least a street or landmark and an area or city).

Name: {{name}}
Address: {{address}}
Notes: {{notes}}`;

/** Whether the flag is on for this store: targeted, or inside the rollout percentage. */
async function isEnabled(workspaceId, transaction = null) {
  const flag = await db.FeatureFlag.findOne({ where: { key: FLAG_KEY }, ...(transaction ? { transaction } : {}) });
  if (!flag || !flag.enabled) return false;
  const targets = Array.isArray(flag.targetWorkspaceIds) ? flag.targetWorkspaceIds : [];
  if (targets.includes(workspaceId)) return true;
  if (flag.rollout >= 100) return true;
  if (flag.rollout <= 0) return false;
  return crypto.createHash('sha256').update(`${FLAG_KEY}:${workspaceId}`).digest().readUInt16BE(0) % 100 < flag.rollout;
}

/**
 * Called by createOrder, inside its transaction, once the order row exists.
 * Queues the check for a `moderate` order of a store that has the feature.
 * Never throws.
 */
async function queueFor(workspaceId, orderId, riskLevel, transaction) {
  try {
    if (!aiEnabled() || riskLevel !== 'moderate' || !(await isEnabled(workspaceId, transaction))) return false;
    await queue.add('ai', JOB_NAME, { orderId }, { transaction, workspaceId, dedupeKey: `ai-order-check:${orderId}` });
    return true;
  } catch (err) {
    logger.error('Could not queue the AI order check', { workspaceId, orderId, message: err.message });
    return false;
  }
}

/** The job: asks the provider and folds its findings into the order's risk. */
async function run(orderId, workspaceId) {
  if (!aiEnabled()) return 'off';
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order || !order.riskLevel || (order.riskReasons || []).some((r) => r.startsWith('ai_'))) return 'skipped';

  let provider;
  try {
    // eslint-disable-next-line global-require
    provider = require('../ai/providers').getProvider();
  } catch (_) {
    return 'no_provider';
  }

  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  const input = {
    name: String(contact.fullName || ''),
    address: [address.addressLine, address.city, address.province].filter(Boolean).join(', '),
    notes: String(order.notes || address.notes || ''),
  };
  const prompt = PROMPT.replace('{{name}}', input.name).replace('{{address}}', input.address).replace('{{notes}}', input.notes);

  const { output } = await provider.generate({
    feature: 'order_check',
    prompt,
    promptVersion: 'order_check.v1',
    input,
    context: {},
    workspaceId: order.workspaceId,
    jobId: null,
  });
  if (!output || typeof output !== 'object') {
    const err = new Error('The AI provider returned no usable answer for the order check');
    err.permanent = true;
    throw err;
  }

  const found = [];
  if (output.is_gibberish === true) found.push('ai_gibberish');
  if (output.is_abusive === true) found.push('ai_abusive');
  if (output.address_complete === false) found.push('ai_incomplete_address');
  if (found.length === 0) return 'clean';

  await db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({ where: { id: orderId }, transaction, lock: transaction.LOCK.UPDATE });
    const reasons = [...new Set([...(locked.riskReasons || []), ...found])];
    const added = found.filter((r) => !(locked.riskReasons || []).includes(r)).reduce((sum, r) => sum + POINTS[r], 0);
    const score = (locked.riskScore || 0) + added;
    await locked.update(
      {
        riskScore: score,
        riskLevel: riskService.levelOf(score),
        riskReasons: reasons,
        ...(found.includes('ai_gibberish') || found.includes('ai_incomplete_address') ? { dataQuality: 'low' } : {}),
      },
      { transaction }
    );
  });
  return 'updated';
}

module.exports = { FLAG_KEY, JOB_NAME, POINTS, isEnabled, queueFor, run };
