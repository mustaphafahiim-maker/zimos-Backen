'use strict';

const crypto = require('crypto');

/**
 * Fawaterak's webhook signatures, as the API reference states them
 * (Webhooks, and the PaymentWebhookPayload / FailedPaymentWebhookPayload /
 * CancelReferenceWebhookPayload / RefundWebhookPayload schemas):
 *
 *   paid     transactionHashKey = HMAC-SHA256(
 *              "TransactionId={transaction_id}&TransactionKey={transaction_key}&PaymentMethod={payment_method}")
 *   failed   hashKey over the same string
 *   cancel   hashKey = HMAC-SHA256("referenceId={referenceId}&PaymentMethod={paymentMethod}")
 *   refund   hashKey = HMAC-SHA256("transactionId={transactionId}&amount={amount}&currency={currency}")
 *
 * keyed with "your vendor API key" — the dashboard's "HASH API key". The
 * order is fixed as written (not sorted) and so is the case of each name.
 * The reference does not name the digest encoding for webhooks; its one
 * explicit sample (the card-token webhook, PHP `hash_hmac(..., false)`) is
 * lowercase hex, so that is what is compared, case-insensitively.
 *
 * What a signature does NOT cover matters as much: the paid webhook's
 * `status`, `paidAmount`, `paidCurrency` and `pay_load` are unsigned, and no
 * signature carries a timestamp. A verified webhook proves Fawaterak sent a
 * body naming that transaction at some point, nothing more — whether it is
 * paid, and for how much, is asked of getTransactionData.
 */

// [name in the signed string, body field], in signing order.
const TRANSACTION_FIELDS = [
  ['TransactionId', 'transaction_id'],
  ['TransactionKey', 'transaction_key'],
  ['PaymentMethod', 'payment_method'],
];
const SIGNED_STRINGS = {
  paid: TRANSACTION_FIELDS,
  failed: TRANSACTION_FIELDS,
  cancel: [
    ['referenceId', 'referenceId'],
    ['PaymentMethod', 'paymentMethod'],
  ],
  refund: [
    ['transactionId', 'transactionId'],
    ['amount', 'amount'],
    ['currency', 'currency'],
  ],
};

const SIGNATURE_FIELDS = {
  paid: 'transactionHashKey',
  failed: 'hashKey',
  cancel: 'hashKey',
  refund: 'hashKey',
};

const KINDS = Object.keys(SIGNED_STRINGS);

function scalar(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** The string Fawaterak signed for this kind of webhook; null when a field it covers is missing. */
function stringToSign(kind, body) {
  const spec = SIGNED_STRINGS[kind];
  if (!spec || !body || typeof body !== 'object') return null;
  const parts = [];
  for (const [name, field] of spec) {
    const value = scalar(body[field]);
    if (value === null) return null;
    parts.push(`${name}=${value}`);
  }
  return parts.join('&');
}

function hmacHex(key, text) {
  return crypto.createHmac('sha256', String(key)).update(text, 'utf8').digest('hex');
}

/** Whether `body` carries a valid signature for `kind`. False for anything missing. */
function verifyWebhook(kind, body, hashKey) {
  if (!hashKey) return false;
  const text = stringToSign(kind, body);
  const provided = body ? body[SIGNATURE_FIELDS[kind]] : undefined;
  if (text === null || typeof provided !== 'string' || !/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = Buffer.from(hmacHex(hashKey, text), 'utf8');
  return crypto.timingSafeEqual(expected, Buffer.from(provided.toLowerCase(), 'utf8'));
}

module.exports = { KINDS, SIGNATURE_FIELDS, stringToSign, verifyWebhook };
