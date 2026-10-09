'use strict';

const Joi = require('joi');
const secretBox = require('../../core/utils/secretBox');
const { ValidationError } = require('../../core/errors/AppError');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Custom headers per endpoint (Lightfunnels' webhook headers): what a
 * receiver asks for — an API key, an Authorization token, a tenant id —
 * sent with every delivery of that endpoint.
 *
 *   webhook_endpoints.custom_headers = [{ name, value: <sealed> }]
 *
 * Values are sealed (secretBox) and never returned: the API shows each name
 * with a masked value. Our own headers (X-Zimos-*, Content-Type, User-Agent)
 * and transport headers cannot be set or overridden.
 *
 * Off (STORE_FEATURES without webhook_headers): nothing is stored, shown or
 * sent — endpoints work as before.
 */

const on = () => storeFeatureOn('webhook_headers');

const MAX_HEADERS = 10;
const NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED = /^(x-zimos-.*|content-type|content-length|user-agent|host|connection|transfer-encoding|keep-alive|upgrade|te|trailer|proxy-.*|expect)$/i;

// `keep: true` (no value) keeps the value already stored under that name.
const schema = Joi.array()
  .items(
    Joi.object({
      name: Joi.string().trim().pattern(NAME).required(),
      // Only what an HTTP header can carry: tab, printable ASCII and Latin-1 — no control
      // characters, no Arabic or emoji (Node refuses them when sending).
      value: Joi.string().max(1000).pattern(/^[\t\x20-\x7e\x80-\xff]*$/).messages({ 'string.pattern.base': 'A header value can only hold Latin letters, digits and symbols' }).when('keep', { is: true, then: Joi.forbidden(), otherwise: Joi.required() }),
      keep: Joi.boolean(),
    })
  )
  .max(MAX_HEADERS)
  .unique((a, b) => a.name.toLowerCase() === b.name.toLowerCase());

/** The list to store, from the request and what is stored now. */
function normalise(input, stored = []) {
  const problems = [];
  const out = [];
  for (const [i, h] of (input || []).entries()) {
    if (RESERVED.test(h.name)) {
      problems.push({ field: `customHeaders.${i}.name`, message: `"${h.name}" is set by Zimos and cannot be changed` });
      continue;
    }
    if (h.keep) {
      const old = (stored || []).find((s) => s.name.toLowerCase() === h.name.toLowerCase());
      if (!old) problems.push({ field: `customHeaders.${i}.value`, message: `No stored value for "${h.name}"` });
      else out.push({ name: h.name, value: old.value });
      continue;
    }
    out.push({ name: h.name, value: secretBox.seal(h.value) });
  }
  if (problems.length) throw new ValidationError(problems, 'Invalid body');
  return out;
}

/** What the API shows: the names, values masked. */
const view = (stored) => (on() ? (stored || []) : []).map((h) => ({ name: h.name, valueMask: secretBox.mask(secretBox.open(h.value)) }));

/** The headers a delivery carries (before Zimos' own, which win). */
function forSend(stored) {
  const out = {};
  if (!on()) return out;
  for (const h of stored || []) {
    if (RESERVED.test(h.name)) continue;
    const value = secretBox.open(h.value);
    if (value !== null && value !== undefined) out[h.name] = value;
  }
  return out;
}

module.exports = { schema, normalise, view, forSend, on, MAX_HEADERS };
