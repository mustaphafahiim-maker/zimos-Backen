'use strict';

const crypto = require('crypto');
const { applyBasisPoints } = require('../../../core/utils/money');

/**
 * The sandbox gateway's fees and payouts (item 384; contract in ./README.md,
 * "Fees and payouts"). No payment company is behind it, so both are worked out
 * from what ZIMOS already holds, the same way every time:
 *
 * - fetchFees: the fee is the account's own test settings `feeBasisPoints`
 *   (1/100 of a percent) of the amount plus `feeFixedMinor`, never more than the
 *   amount. Both unset = no fee. They are the merchant's numbers, typed on the
 *   connect form to try the ledger; nothing here is a real price.
 * - listPayouts: one payout per UTC day and currency for the days that are over
 *   (today's money waits for tomorrow), from the `candidates` the core passes:
 *   that day's paid payments less its processed refunds. It arrives two days
 *   after that day and is `paid` once that date has come, `in_transit` before.
 *   A day whose refunds outweigh its payments pays nothing. The id is
 *   `sbxpo_<day>_<currency>_<signature>`, so asking again gives the same payout.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ARRIVAL_DAYS = 2;

const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);

function feeOf(amount, settings = {}) {
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) return 0;
  const fee = applyBasisPoints(value, Math.min(int(settings.feeBasisPoints), 10000)) + int(settings.feeFixedMinor);
  return Math.min(fee, value);
}

/** The fee of a captured sandbox payment, in its own currency. */
async function fetchFees(creds, { payment, settings = {} }) {
  const amount = Number(payment.amount);
  const fee = feeOf(amount, settings);
  return { fee, net: amount - fee, currency: payment.currency };
}

const dayOf = (date) => new Date(date).toISOString().slice(0, 10);

async function listPayouts(creds, { since, settings = {}, candidates = {}, now = new Date() }) {
  const today = dayOf(now);
  const from = since ? dayOf(since) : null;
  const days = new Map(); // "day|currency" → { day, currency, transactions }
  const add = (at, currency, line) => {
    if (!at || !line.transactionId) return;
    const day = dayOf(at);
    if (day >= today || (from && day < from)) return;
    const key = `${day}|${currency}`;
    if (!days.has(key)) days.set(key, { day, currency, transactions: [] });
    days.get(key).transactions.push(line);
  };
  for (const p of candidates.payments || []) {
    const fee = feeOf(p.amount, settings);
    add(p.paidAt, p.currency, { type: 'payment', transactionId: p.transactionId, amount: Number(p.amount), fee, net: Number(p.amount) - fee, currency: p.currency });
  }
  for (const r of candidates.refunds || []) {
    add(r.processedAt, r.currency, { type: 'refund', transactionId: r.reference, amount: -Number(r.amount), fee: 0, net: -Number(r.amount), currency: r.currency });
  }

  const payouts = [];
  for (const { day, currency, transactions } of days.values()) {
    const amount = transactions.reduce((n, t) => n + t.net, 0);
    if (amount <= 0) continue;
    const arrival = dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + ARRIVAL_DAYS * DAY_MS));
    const signature = crypto.createHmac('sha256', String(creds.signingSecret)).update(`payout|${day}|${currency}`).digest('hex').slice(0, 10);
    payouts.push({
      externalId: `sbxpo_${day.replace(/-/g, '')}_${currency}_${signature}`,
      amount,
      currency,
      fee: transactions.reduce((n, t) => n + t.fee, 0),
      arrivalDate: arrival,
      status: arrival <= today ? 'paid' : 'in_transit',
      transactions,
    });
  }
  return payouts.sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
}

module.exports = { fetchFees, listPayouts, wantsPayoutCandidates: true, feeOf };
