'use strict';

/**
 * What a product's custom fields add to its price (SPEC §7.2 "Custom Data":
 * `priceDeltaAmount`). A field the merchant priced — "+20 EGP to engrave a
 * name" — adds its amount to the line's unit price when the shopper filled it
 * in; an empty answer adds nothing. Amounts are integer minor units, never
 * negative.
 *
 * Every price the shopper sees and pays goes through here, so they agree:
 * orderService.priceLine (orders, the shipping quote, abandoned checkouts) and
 * the cart's totals.
 */

const filled = (v) => typeof v === 'string' && v.trim() !== '';
const amount = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * The unit price added by `answers` — the input shape ({ fieldId: answer })
 * or a stored snapshot ([{ fieldId, value | uploadId, priceDeltaAmount }]).
 * With the product's current `fields`, their amounts count (the order and the
 * quote price from the product as it is now); without them, a snapshot's own.
 */
function customFieldsDelta(fields, answers) {
  if (!answers) return 0;
  const byId = Array.isArray(fields) ? new Map(fields.map((f) => [f.id, f])) : null;
  const entries = Array.isArray(answers)
    ? answers.map((e) => [e && e.fieldId, e && (e.type === 'image' ? e.uploadId : e.value), e && e.priceDeltaAmount])
    : typeof answers === 'object'
      ? Object.entries(answers).map(([id, v]) => [id, v, 0])
      : [];
  let delta = 0;
  for (const [id, value, stored] of entries) {
    if (!filled(value)) continue;
    if (byId) delta += byId.has(id) ? amount(byId.get(id).priceDeltaAmount) : 0;
    else delta += amount(stored);
  }
  return delta;
}

module.exports = { customFieldsDelta };
