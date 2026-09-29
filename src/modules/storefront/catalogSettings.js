'use strict';

const Joi = require('joi');

/**
 * How a store's product listing looks: whether it has a filter sidebar, which
 * filters it shows and in what order, and the sort a shopper starts on.
 * Stored in workspaces.settings.storefront_catalog (no migration: a key in the
 * existing JSONB), written whole through PATCH /workspaces/:id and read by the
 * storefront through GET /store/:id as `catalog`.
 *
 * Filters, in sidebar order:
 *   { key: 'collections' }            the collection tree
 *   { key: 'price' }                  a price range
 *   { key: 'tags' }                   product tags
 *   { key: 'options' }                every product option in use (Size, Color…)
 *   { key: 'option', name: 'Size' }   one product option by name
 * A store that has saved nothing gets DEFAULT_CATALOG_SETTINGS.
 */

const CATALOG_SORTS = ['newest', 'price_asc', 'price_desc', 'name', 'position'];
const FILTER_KEYS = ['collections', 'price', 'tags', 'options', 'option'];
const MAX_FILTERS = 30;

const DEFAULT_CATALOG_SETTINGS = Object.freeze({
  sidebar_enabled: true,
  default_sort: 'newest',
  filters: Object.freeze([{ key: 'collections' }, { key: 'price' }, { key: 'options' }, { key: 'tags' }]),
});

const filterSchema = Joi.object({
  key: Joi.string()
    .valid(...FILTER_KEYS)
    .required(),
  // Only for a single option; the option name exactly as the variants use it.
  name: Joi.string().trim().min(1).max(100).when('key', { is: 'option', then: Joi.required(), otherwise: Joi.forbidden() }),
});

/** The PATCH shape. Every key must be given explicitly; the object replaces what was stored. */
const catalogSettingsSchema = Joi.object({
  sidebar_enabled: Joi.boolean().required(),
  default_sort: Joi.string()
    .valid(...CATALOG_SORTS)
    .required(),
  filters: Joi.array()
    .items(filterSchema)
    .max(MAX_FILTERS)
    .unique((a, b) => a.key === b.key && (a.name || '') === (b.name || ''))
    .required(),
});

/**
 * The effective settings for a stored blob: anything missing or malformed
 * falls back to the default, so a hand-edited or older blob never breaks the
 * storefront.
 */
function resolveCatalogSettings(settings) {
  const stored = settings && typeof settings === 'object' ? settings.storefront_catalog : null;
  if (!stored || typeof stored !== 'object') return clone(DEFAULT_CATALOG_SETTINGS);
  const { value, error } = catalogSettingsSchema.validate(
    {
      sidebar_enabled: stored.sidebar_enabled ?? DEFAULT_CATALOG_SETTINGS.sidebar_enabled,
      default_sort: stored.default_sort ?? DEFAULT_CATALOG_SETTINGS.default_sort,
      filters: stored.filters ?? DEFAULT_CATALOG_SETTINGS.filters,
    },
    { stripUnknown: true }
  );
  return error ? clone(DEFAULT_CATALOG_SETTINGS) : value;
}

function clone(settings) {
  return { ...settings, filters: settings.filters.map((f) => ({ ...f })) };
}

module.exports = {
  CATALOG_SORTS,
  DEFAULT_CATALOG_SETTINGS,
  catalogSettingsSchema,
  resolveCatalogSettings,
};
