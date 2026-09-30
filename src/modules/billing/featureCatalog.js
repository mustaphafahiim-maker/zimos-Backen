'use strict';

/**
 * The feature keys a plan can list in plans.features — the same ten the
 * platform console offers when a plan is created (apps/platform-admin
 * lib/planFeatures.ts, api-client PlanFeatureKey), now known to the backend
 * too, so an override can be refused for a key nobody defined. Every one of
 * them is an on/off feature: none carries a numeric limit today, so an
 * override's `value` must stay empty.
 *
 * Adding a key: here, in PlanFeatureKey and in the console's label list.
 */
const FEATURE_CATALOG = Object.freeze([
  { key: 'custom_domain', type: 'boolean' },
  { key: 'funnels', type: 'boolean' },
  { key: 'whatsapp_confirmation', type: 'boolean' },
  { key: 'abandoned_cart', type: 'boolean' },
  { key: 'multi_warehouse', type: 'boolean' },
  { key: 'api_access', type: 'boolean' },
  { key: 'staff_accounts', type: 'boolean' },
  { key: 'advanced_analytics', type: 'boolean' },
  { key: 'remove_branding', type: 'boolean' },
  { key: 'priority_support', type: 'boolean' },
]);

const FEATURE_KEYS = Object.freeze(FEATURE_CATALOG.map((f) => f.key));
const byKey = new Map(FEATURE_CATALOG.map((f) => [f.key, f]));

const featureDefinition = (key) => byKey.get(key) || null;

/**
 * plans.features has been stored two ways — a { key: true } map (the first
 * seed) and a plain array (the console's plan editor). The enabled keys.
 */
function planFeatureKeys(features) {
  if (Array.isArray(features)) return features.filter((k) => typeof k === 'string');
  if (features && typeof features === 'object') return Object.keys(features).filter((k) => features[k]);
  return [];
}

module.exports = { FEATURE_CATALOG, FEATURE_KEYS, featureDefinition, planFeatureKeys };
