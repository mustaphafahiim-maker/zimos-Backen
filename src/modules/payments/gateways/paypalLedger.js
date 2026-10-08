'use strict';

const { GatewayAuthError, GatewayRejectedError } = require('./gatewayErrors');

/**
 * PayPal's fees and payouts (item 399; contract in ./README.md, "Fees and
 * payouts"), on PayPal's published REST API (paypal/paypal-rest-api-specifications:
 * payments_payment_v2.json and reporting_transactions_v1.json) with the
 * merchant's own app keys:
 *
 * - fetchFees: GET /v2/payments/captures/:id (the call `inquireTransaction`
 *   already makes). A completed capture carries `seller_receivable_breakdown`:
 *   `paypal_fee` and `net_amount` in the currency of the transaction ("not
 *   available for transactions that are in pending state" → null, asked again).
 *   When the capture was credited in another currency of the PayPal account,
 *   `receivable_amount` and `paypal_fee_in_receivable_currency` give the same
 *   pair in that currency, and that pair is used when PayPal gives both.
 * - listPayouts: GET /v1/reporting/transactions (Transaction Search, which the
 *   app must have switched on: scope reporting/search/read) with
 *   `transaction_type` = each withdrawal event code of PayPal's T04 group
 *   (money taken out of the PayPal balance to the merchant's bank), in windows
 *   of at most 31 days (the API's limit), 500 a page. A withdrawal is taken out
 *   of the pooled PayPal balance, so PayPal does not say which sales it
 *   carried: each payout comes without lines (like a Stripe manual payout).
 *   PayPal does not report when the bank receives it either: the date shown is
 *   the day the withdrawal was made, in the account's time zone.
 *
 * No fee rate is worked out here: every number is PayPal's.
 */

// PayPal's T04 group, "Bank withdrawal from PayPal account": general withdrawal, AutoSweep,
// withdrawal to Hyperwallet, withdrawal started by hand. transaction_type takes one code at a time.
const WITHDRAWAL_CODES = ['T0400', 'T0401', 'T0402', 'T0403'];
// transaction_status: S completed, P pending, D denied, V reversed (the money went back to the balance).
const STATUS = { S: 'paid', P: 'in_transit', D: 'failed', V: 'failed' };
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000 - 1000;
const MAX_WINDOWS = 13;
const MAX_PAGES = 5;
const PAGE = 500;
// Currencies PayPal takes without decimals; the rest have two.
const NO_DECIMALS = ['HUF', 'JPY', 'TWD'];

/** A PayPal money object → integer minor units in its currency, or null. */
function moneyOf(m) {
  if (!m || typeof m !== 'object' || m.value === undefined || m.value === null || m.value === '') return null;
  const currency = String(m.currency_code || '').toUpperCase();
  const value = Number(m.value);
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(value)) return null;
  return { amount: Math.round(value * (NO_DECIMALS.includes(currency) ? 1 : 100)), currency };
}

/** The fee and net of a capture's seller_receivable_breakdown, or null when PayPal does not give them. */
function feesOfCapture(capture) {
  const b = capture && capture.seller_receivable_breakdown;
  if (!b || typeof b !== 'object') return null;
  const receivable = moneyOf(b.receivable_amount);
  const feeThere = moneyOf(b.paypal_fee_in_receivable_currency);
  if (receivable && feeThere && receivable.currency === feeThere.currency) {
    return { fee: Math.abs(feeThere.amount), net: receivable.amount, currency: receivable.currency };
  }
  const net = moneyOf(b.net_amount);
  if (!net) return null;
  const fee = moneyOf(b.paypal_fee);
  if (fee && fee.currency === net.currency) return { fee: Math.abs(fee.amount), net: net.amount, currency: net.currency };
  // No paypal_fee: no fee only when nothing was taken off the gross.
  const gross = moneyOf(b.gross_amount);
  if (!fee && gross && gross.currency === net.currency && gross.amount === net.amount) return { fee: 0, net: net.amount, currency: net.currency };
  return null;
}

const isoSeconds = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

module.exports = function paypalLedger({ call, token, captureOf }) {
  async function captureIdOf(creds, payment) {
    if (payment.providerTransactionId && payment.providerTransactionId !== payment.providerOrderId) return payment.providerTransactionId;
    if (!payment.providerOrderId) return null;
    const o = await call(creds, 'GET', `/v2/checkout/orders/${encodeURIComponent(payment.providerOrderId)}`, { what: 'the payment' });
    const capture = captureOf(o);
    return capture && capture.id ? capture.id : null;
  }

  async function fetchFees(creds, { payment }) {
    const captureId = await captureIdOf(creds, payment);
    if (!captureId) return null;
    const capture = await call(creds, 'GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, { what: 'the payment fee' }).catch((err) => {
      if (err.notFound) return null;
      throw err;
    });
    if (!capture || !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(capture.status)) return null;
    return feesOfCapture(capture);
  }

  /** One page of Transaction Search; a refused permission is said plainly (the keys themselves are fine). */
  async function search(creds, params) {
    try {
      return await call(creds, 'GET', `/v1/reporting/transactions?${new URLSearchParams(params).toString()}`, { what: 'the payouts' });
    } catch (err) {
      if (err instanceof GatewayAuthError) {
        throw new GatewayRejectedError('PayPal refused to list the payouts: turn on "Transaction search" in your PayPal app\'s features (developer.paypal.com → Apps & Credentials), then refresh.');
      }
      throw err;
    }
  }

  function payoutOf(info) {
    const amount = moneyOf(info.transaction_amount);
    if (!info.transaction_id || !amount) return null;
    const fee = moneyOf(info.fee_amount);
    const day = String(info.transaction_initiation_date || '').slice(0, 10);
    return {
      externalId: String(info.transaction_id),
      amount: Math.abs(amount.amount),
      currency: amount.currency,
      fee: fee && fee.currency === amount.currency ? Math.abs(fee.amount) : 0,
      arrivalDate: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
      status: STATUS[info.transaction_status] || 'pending',
      transactions: [],
    };
  }

  async function listPayouts(creds, { since, now = new Date() }) {
    await token(creds); // keys refused → the usual GatewayAuthError, before any search
    const byId = new Map();
    const end = new Date(now).getTime();
    let start = Math.max(new Date(since).getTime(), end - MAX_WINDOWS * WINDOW_MS);
    for (let w = 0; w < MAX_WINDOWS && start < end; w += 1) {
      const stop = Math.min(start + WINDOW_MS, end);
      for (const code of WITHDRAWAL_CODES) {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const res = await search(creds, {
            start_date: isoSeconds(start),
            end_date: isoSeconds(stop),
            transaction_type: code,
            fields: 'transaction_info',
            page_size: String(PAGE),
            page: String(page),
          });
          for (const d of Array.isArray(res.transaction_details) ? res.transaction_details : []) {
            const info = (d && d.transaction_info) || {};
            if (!String(info.transaction_event_code || code).startsWith('T04')) continue;
            const p = payoutOf(info);
            if (p) byId.set(p.externalId, p);
          }
          if (!(Number(res.total_pages) > page)) break;
        }
      }
      start = stop;
    }
    return [...byId.values()];
  }

  return { fetchFees, listPayouts };
};

module.exports.feesOfCapture = feesOfCapture;
module.exports.WITHDRAWAL_CODES = WITHDRAWAL_CODES;
