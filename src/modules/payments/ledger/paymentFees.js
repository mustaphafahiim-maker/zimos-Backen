'use strict';

const { Op } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const gateways = require('../gateways');

/**
 * The gateway's fee on a captured online payment (item 384): the optional
 * adapter function `fetchFees(credentials, { payment, settings })` answers
 * `{ fee, net, currency }` in integer minor units of the gateway's settlement
 * currency, or null while the gateway does not know it yet (gateways/README.md,
 * "Fees and payouts").
 *
 * Never on the capture's path: right after a capture commits, `fillSoon` asks
 * once in the background; the `payments.fetch_fees` job asks again for what is
 * still unknown, at most every RETRY_AFTER_MS, for FEES_WINDOW_DAYS after the
 * payment. A payout that lists the payment fills it too (payoutSync.js).
 */

const CAPTURED = ['captured', 'partially_refunded', 'refunded'];
const RETRY_AFTER_MS = 30 * 60 * 1000;
const FEES_WINDOW_DAYS = 7;

const codesWithFees = () => gateways.listAdapters().filter((a) => typeof a.fetchFees === 'function').map((a) => a.code);

/** A whole, non-negative fee and a whole net in a three-letter currency, or null. */
function validFees(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const fee = Number(answer.fee);
  const net = Number(answer.net);
  const currency = String(answer.currency || '').toUpperCase();
  if (!Number.isInteger(fee) || fee < 0 || !Number.isInteger(net) || !/^[A-Z]{3}$/.test(currency)) return null;
  return { fee, net, currency };
}

/**
 * Asks the gateway for one payment's fee and stores it. Resolves 'filled' | 'unknown' | 'skipped'.
 * Throws only when the gateway could not be asked (the job logs it and tries later).
 */
async function fillFees(paymentId) {
  const payment = await db.Payment.findByPk(paymentId);
  if (!payment || !CAPTURED.includes(payment.status) || payment.feeAmount !== null) return 'skipped';
  const adapter = gateways.getAdapter(payment.providerCode);
  if (!adapter || typeof adapter.fetchFees !== 'function') return 'skipped';
  await db.Payment.update({ feesCheckedAt: new Date() }, { where: { id: payment.id } });
  const ctx = await require('../gatewayRuntime').contextFor(payment.workspaceId, payment.providerCode);
  const fees = validFees(await ctx.adapter.fetchFees(ctx.credentials, { payment, settings: ctx.settings }));
  if (!fees) return 'unknown';
  // A payout that listed it in the meantime has already said.
  const [n] = await db.Payment.update(
    { feeAmount: fees.fee, netAmount: fees.net, feeCurrency: fees.currency },
    { where: { id: payment.id, feeAmount: null } }
  );
  return n ? 'filled' : 'skipped';
}

/** Right after a capture commits: one try in the background, never awaited by the capture. */
function fillSoon(paymentId) {
  setImmediate(() => {
    module.exports.fillFees(paymentId).catch((err) => {
      logger.warn('[payments] could not read the gateway fee yet', { paymentId, reason: err.message });
    });
  });
}

/** The job: captured payments of the last days whose fee is still unknown. */
async function sweep({ limit = 50 } = {}) {
  const codes = codesWithFees();
  if (!codes.length) return { checked: 0, filled: 0 };
  const rows = await db.Payment.findAll({
    attributes: ['id'],
    where: {
      providerCode: { [Op.in]: codes },
      status: { [Op.in]: CAPTURED },
      feeAmount: null,
      paidAt: { [Op.gte]: new Date(Date.now() - FEES_WINDOW_DAYS * 24 * 60 * 60 * 1000) },
      [Op.or]: [{ feesCheckedAt: null }, { feesCheckedAt: { [Op.lt]: new Date(Date.now() - RETRY_AFTER_MS) } }],
    },
    order: [['paidAt', 'ASC']],
    limit,
  });
  let filled = 0;
  for (const row of rows) {
    try {
      if ((await module.exports.fillFees(row.id)) === 'filled') filled += 1;
    } catch (err) {
      logger.warn('[payments] could not read a gateway fee', { paymentId: row.id, reason: err.message });
    }
  }
  return { checked: rows.length, filled };
}

module.exports = { fillFees, fillSoon, sweep, validFees, CAPTURED, FEES_WINDOW_DAYS };
