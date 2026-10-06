'use strict';

/**
 * "Send Lead instead of Purchase" (Lightfunnels' conversion event): a
 * cash-on-delivery store often optimises its ads on leads — an order placed
 * is not money yet — so the order's conversion is reported as a Lead.
 *
 *   workspaces.settings.conversion_event   'purchase' (default) | 'lead'
 *   funnels.settings.conversionEvent       null (the store's) | 'purchase' | 'lead'
 *
 * The order's funnel wins over the store. Everything else is unchanged: the
 * moment it is sent (purchaseTiming.js), its value, its event id (so the
 * browser and server events still dedup), and sending it once.
 *
 * Each platform's own event name for each kind (the browser pixel uses the
 * same names; apps/storefront lib/track.ts).
 */

const KINDS = ['purchase', 'lead'];
const DEFAULT_KIND = 'purchase';

const EVENT_NAMES = Object.freeze({
  meta: { purchase: 'Purchase', lead: 'Lead' },
  tiktok: { purchase: 'CompletePayment', lead: 'SubmitForm' },
  snapchat: { purchase: 'PURCHASE', lead: 'SIGN_UP' },
  google: { purchase: 'purchase', lead: 'generate_lead' },
  pinterest: { purchase: 'checkout', lead: 'lead' },
});

const storeKindOf = (settings) => (settings && KINDS.includes(settings.conversion_event) ? settings.conversion_event : DEFAULT_KIND);

/** The kind for an order: its funnel's choice, else the store's. */
function kindFor(workspaceSettings, funnelSettings) {
  const own = funnelSettings && funnelSettings.conversionEvent;
  return KINDS.includes(own) ? own : storeKindOf(workspaceSettings);
}

const eventNameFor = (platform, kind) => (EVENT_NAMES[platform] || {})[kind] || null;

module.exports = { KINDS, DEFAULT_KIND, EVENT_NAMES, storeKindOf, kindFor, eventNameFor };
