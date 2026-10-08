'use strict';

const { GatewayRejectedError } = require('./gatewayErrors');

/**
 * Stripe's fees and payouts (item 384; contract in ./README.md, "Fees and
 * payouts"), on its documented API with the merchant's secret key:
 *
 * - fetchFees: GET /v1/payment_intents/:id?expand[]=latest_charge.balance_transaction.
 *   The charge's balance transaction holds `fee` and `net` in the account's
 *   settlement currency; until Stripe has made it (rare, seconds) the answer is
 *   null and the job asks again.
 * - listPayouts: GET /v1/payouts?created[gte]=<since> (newest first, 100 a page),
 *   then for each payout GET /v1/balance_transactions?payout=<po_…>&expand[]=data.source:
 *   the lines it carried. A charge / payment line names its PaymentIntent (what
 *   ZIMOS keeps as the payment's transaction id), a refund / payment_refund line
 *   its re_… (the refund's reference); the payout's own line is left out; the
 *   rest (adjustments, Stripe fees, disputes) are `other`. Stripe lists the
 *   lines of automatic payouts only; for a manual payout the list is refused and
 *   the payout comes without lines.
 *
 * Bounded: MAX_PAYOUT_PAGES pages of payouts and MAX_LINE_PAGES pages of lines per payout.
 */

const MAX_PAYOUT_PAGES = 5;
const MAX_LINE_PAGES = 20;
const PAGE = 100;

const PAYMENT_TYPES = ['charge', 'payment'];
const REFUND_TYPES = ['refund', 'payment_refund'];
const STATUS = { paid: 'paid', pending: 'pending', in_transit: 'in_transit', canceled: 'canceled', failed: 'failed' };

module.exports = function stripeLedger({ call, idOf }) {
  async function intentIdOf(creds, payment) {
    if (/^pi_/.test(String(payment.providerTransactionId || ''))) return payment.providerTransactionId;
    if (!payment.providerOrderId) return null;
    const session = await call(creds, 'GET', `/v1/checkout/sessions/${encodeURIComponent(payment.providerOrderId)}`, { what: 'the payment' });
    return idOf(session.payment_intent);
  }

  async function fetchFees(creds, { payment }) {
    const intentId = await intentIdOf(creds, payment);
    if (!intentId) return null;
    const intent = await call(creds, 'GET', `/v1/payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge.balance_transaction`, { what: 'the payment fee' });
    const charge = intent && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const bt = charge && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
    if (intent.status !== 'succeeded' || !bt || !Number.isInteger(bt.fee) || !Number.isInteger(bt.net)) return null;
    return { fee: bt.fee, net: bt.net, currency: String(bt.currency || '').toUpperCase() };
  }

  const qs = (params) => new URLSearchParams(params).toString();

  function lineOf(bt) {
    const source = bt.source && typeof bt.source === 'object' ? bt.source : null;
    const currency = String(bt.currency || '').toUpperCase();
    const base = { amount: Number(bt.amount), fee: Number(bt.fee || 0), net: Number(bt.net), currency };
    if (PAYMENT_TYPES.includes(bt.type)) {
      return { type: 'payment', transactionId: (source && idOf(source.payment_intent)) || (source && source.id) || idOf(bt.source), ...base };
    }
    if (REFUND_TYPES.includes(bt.type)) return { type: 'refund', transactionId: (source && source.id) || idOf(bt.source), ...base };
    return { type: 'other', transactionId: bt.id, ...base };
  }

  async function linesOf(creds, payoutId) {
    const lines = [];
    let after = null;
    for (let page = 0; page < MAX_LINE_PAGES; page += 1) {
      const params = { payout: payoutId, limit: String(PAGE), 'expand[]': 'data.source' };
      if (after) params.starting_after = after;
      const list = await call(creds, 'GET', `/v1/balance_transactions?${qs(params)}`, { what: 'the payout lines' });
      const data = Array.isArray(list.data) ? list.data : [];
      for (const bt of data) if (bt.type !== 'payout') lines.push(lineOf(bt));
      if (!list.has_more || !data.length) break;
      after = data[data.length - 1].id;
    }
    return lines;
  }

  async function listPayouts(creds, { since }) {
    const payouts = [];
    let after = null;
    for (let page = 0; page < MAX_PAYOUT_PAGES; page += 1) {
      const params = { limit: String(PAGE), 'created[gte]': String(Math.floor(new Date(since).getTime() / 1000)) };
      if (after) params.starting_after = after;
      const list = await call(creds, 'GET', `/v1/payouts?${qs(params)}`, { what: 'the payouts' });
      const data = Array.isArray(list.data) ? list.data : [];
      for (const po of data) {
        let transactions = [];
        try {
          transactions = await linesOf(creds, po.id);
        } catch (err) {
          // A manual payout: Stripe does not say what it carried.
          if (!(err instanceof GatewayRejectedError)) throw err;
        }
        payouts.push({
          externalId: po.id,
          amount: Number(po.amount),
          currency: String(po.currency || '').toUpperCase(),
          fee: transactions.reduce((n, t) => n + (Number.isInteger(t.fee) ? t.fee : 0), 0),
          arrivalDate: po.arrival_date ? new Date(Number(po.arrival_date) * 1000) : null,
          status: STATUS[po.status] || 'pending',
          transactions,
        });
      }
      if (!list.has_more || !data.length) break;
      after = data[data.length - 1].id;
    }
    return payouts;
  }

  return { fetchFees, listPayouts };
};
