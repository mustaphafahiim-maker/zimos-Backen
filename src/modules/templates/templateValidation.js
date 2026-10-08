'use strict';

const Joi = require('joi');

// The three things the gallery grid can hold. Shared with the admin write
// path via TEMPLATE_KINDS so the tab filter and the editor can never drift.
const TEMPLATE_KINDS = ['store', 'funnel', 'landing'];

module.exports = {
  TEMPLATE_KINDS,

  // `kind` is the grid's tab. Omitted means every kind, which is the tab the
  // picker opens on, so it stays optional with no default.
  list: {
    query: Joi.object({
      kind: Joi.string().valid(...TEMPLATE_KINDS).optional(),
      category: Joi.string().trim().max(100).optional(),
      // From the template's stored isFree flag (no prices are charged in code).
      price: Joi.string().valid('free', 'paid').optional(),
      // A template has a direction, not a language: ar → rtl, en / fr → ltr.
      rtl: Joi.boolean().optional(),
      language: Joi.string().valid('ar', 'en', 'fr').optional(),
      // name (A→Z, the picker's order so far) | newest | most_used.
      sort: Joi.string().valid('name', 'newest', 'most_used').default('name'),
    }),
  },

  getOne: { params: Joi.object({ id: Joi.string().uuid().required() }) },
};
