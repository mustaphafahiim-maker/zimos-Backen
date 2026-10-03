'use strict';

/**
 * Turns `?option[Size]=M&option[Size]=L&option[Color]=Red` into
 * `query.options = { Size: ['M', 'L'], Color: ['Red'] }` before validation.
 *
 * Express 5's default query parser is the simple one, so bracketed keys arrive
 * as literal names ("option[Size]"); the validate middleware strips unknown
 * keys, so without this they would silently vanish. Names and values are
 * trimmed and checked by the Joi schema (storefrontValidation.listProducts)
 * right after. A value given as "M,L" is split, since some clients join them.
 */
const OPTION_KEY = /^option\[(.{1,100})\]$/;

function collectOptionFilters(req, res, next) {
  const query = { ...(req.query || {}) };
  const options = {};
  for (const key of Object.keys(query)) {
    const match = OPTION_KEY.exec(key);
    if (!match) continue;
    const name = match[1].trim();
    const values = []
      .concat(query[key])
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    delete query[key];
    if (!name || values.length === 0) continue;
    options[name] = [...new Set([...(options[name] || []), ...values])];
  }
  if (Object.keys(options).length > 0) query.options = options;
  // req.query is a getter in Express 5; redefine it as validate.js does.
  Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
  next();
}

module.exports = { collectOptionFilters };
