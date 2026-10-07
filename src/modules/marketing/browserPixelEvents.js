'use strict';

/*
 * The browser-only ad platforms (spec-gaps item 251): X (Twitter), Taboola,
 * Outbrain, Kwai, Reddit and Microsoft Ads (UET). They have no server-side
 * sending here; the storefront loads each tag and fires the standard events
 * under the names below, which publicPixels() hands it with the pixel.
 *
 *   internal event   → each platform's event name
 *   (null = the platform has no such event: don't send it)
 *
 * X has no fixed names: each conversion is an event id made in X Ads Manager
 * ("tw-<pixel>-<event>"), saved per pixel in config.eventIds; an event with
 * no id is not sent to X (its page view comes with the base tag).
 */

const EVENTS = ['page_view', 'view_content', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase', 'lead'];

const NAMES = Object.freeze({
  taboola: { page_view: 'page_view', view_content: 'view_content', add_to_cart: 'add_to_cart', begin_checkout: 'start_checkout', add_payment_info: 'add_payment_info', purchase: 'make_purchase', lead: 'lead' },
  outbrain: { page_view: 'PAGE_VIEW', view_content: 'View Content', add_to_cart: 'Add To Cart', begin_checkout: 'Checkout', add_payment_info: null, purchase: 'Purchase', lead: 'Lead' },
  kwai: { page_view: null, view_content: 'EVENT_CONTENT_VIEW', add_to_cart: 'EVENT_ADD_TO_CART', begin_checkout: 'EVENT_INITIATED_CHECKOUT', add_payment_info: 'EVENT_ADD_PAYMENT_INFO', purchase: 'EVENT_PURCHASE', lead: 'EVENT_FORM_SUBMIT' },
  reddit: { page_view: 'PageVisit', view_content: 'ViewContent', add_to_cart: 'AddToCart', begin_checkout: null, add_payment_info: null, purchase: 'Purchase', lead: 'Lead' },
  microsoft: { page_view: null, view_content: 'view_item', add_to_cart: 'add_to_cart', begin_checkout: 'begin_checkout', add_payment_info: 'add_payment_info', purchase: 'purchase', lead: 'submit_lead_form' },
});

const X_EVENT_ID = /^tw-[a-z0-9]{3,12}-[a-z0-9]{3,12}$/i;

/** The event names the storefront fires for a browser-only pixel; null for the platforms that have their own handling. */
function eventsFor(platform, config) {
  if (platform === 'x') {
    const ids = (config && config.eventIds) || {};
    return Object.fromEntries(EVENTS.map((e) => [e, ids[e] || null]));
  }
  return NAMES[platform] || null;
}

module.exports = { EVENTS, NAMES, X_EVENT_ID, eventsFor };
