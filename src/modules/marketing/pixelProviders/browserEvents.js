'use strict';

const metaCapi = require('./metaCapi');
const tiktokCapi = require('./tiktokCapi');
const snapchatCapi = require('./snapchatCapi');
const googleMp = require('./googleMp');

/**
 * The events other than Purchase (SPEC §13.2), sent server-side with the same
 * event id the browser pixel used so each platform counts them once.
 *
 * Purchase keeps its own code path (each provider's sendPurchase, driven by
 * the stored order). The events here are anonymous storefront events: there
 * is no order, so no phone or email — matching relies on the browser ids the
 * storefront forwards (fbp/fbc, ttp/ttclid, Snap click id), the IP and the
 * user agent. They go through each provider's own `call`, so the endpoints,
 * auth and error handling are exactly the ones Purchase uses.
 */

// internal name → each platform's name
const NAMES = Object.freeze({
  page_view: { meta: 'PageView', tiktok: 'Pageview', snapchat: 'PAGE_VIEW', google: 'page_view', pinterest: 'page_visit' },
  view_content: { meta: 'ViewContent', tiktok: 'ViewContent', snapchat: 'VIEW_CONTENT', google: 'view_item', pinterest: 'page_visit' },
  add_to_cart: { meta: 'AddToCart', tiktok: 'AddToCart', snapchat: 'ADD_CART', google: 'add_to_cart', pinterest: 'add_to_cart' },
  begin_checkout: { meta: 'InitiateCheckout', tiktok: 'InitiateCheckout', snapchat: 'START_CHECKOUT', google: 'begin_checkout' },
  add_payment_info: { meta: 'AddPaymentInfo', tiktok: 'AddPaymentInfo', snapchat: 'ADD_BILLING', google: 'add_payment_info' },
  lead: { meta: 'Lead', tiktok: 'SubmitForm', snapchat: 'SIGN_UP', google: 'generate_lead', pinterest: 'lead' },
});
// Pinterest has no checkout-start or payment-info event: those two are not sent to it.
const EVENT_NAMES = Object.keys(NAMES);

const seconds = (date) => Math.floor(new Date(date || Date.now()).getTime() / 1000);
const money = (event) =>
  event.valueMinor !== undefined && event.valueMinor !== null && event.currency
    ? { currency: event.currency, value: Number(event.valueMinor) / 100 }
    : {};

/**
 * event: { name, eventId, occurredAt, url, valueMinor, currency, contentIds, numItems,
 *          clientIp, userAgent, visitorId, browser: { fbp, fbc, ttp, ttclid, scCid } }
 */
const SENDERS = {
  meta({ pixel, token }, event) {
    const b = event.browser || {};
    return metaCapi.call(pixel.pixelId, token, {
      data: [
        {
          event_name: NAMES[event.name].meta,
          event_time: seconds(event.occurredAt),
          event_id: event.eventId,
          action_source: 'website',
          ...(event.url ? { event_source_url: event.url } : {}),
          user_data: {
            ...(event.clientIp ? { client_ip_address: event.clientIp } : {}),
            ...(event.userAgent ? { client_user_agent: event.userAgent } : {}),
            ...(b.fbp ? { fbp: b.fbp } : {}),
            ...(b.fbc ? { fbc: b.fbc } : {}),
            ...(event.visitorId ? { external_id: [metaCapi.sha256(event.visitorId)] } : {}),
          },
          custom_data: {
            ...money(event),
            ...(event.contentIds && event.contentIds.length ? { content_ids: event.contentIds, content_type: 'product' } : {}),
            ...(event.numItems ? { num_items: event.numItems } : {}),
          },
        },
      ],
      ...(pixel.testEventCode ? { test_event_code: pixel.testEventCode } : {}),
    });
  },

  tiktok({ pixel, token }, event) {
    const b = event.browser || {};
    return tiktokCapi.call(token, {
      event_source: 'web',
      event_source_id: pixel.pixelId,
      data: [
        {
          event: NAMES[event.name].tiktok,
          event_time: seconds(event.occurredAt),
          event_id: event.eventId,
          user: {
            ...(event.clientIp ? { ip: event.clientIp } : {}),
            ...(event.userAgent ? { user_agent: event.userAgent } : {}),
            ...(b.ttp ? { ttp: b.ttp } : {}),
            ...(b.ttclid ? { ttclid: b.ttclid } : {}),
            ...(event.visitorId ? { external_id: tiktokCapi.sha256(event.visitorId) } : {}),
          },
          ...(event.url ? { page: { url: event.url } } : {}),
          properties: {
            content_type: 'product',
            ...money(event),
            ...(event.contentIds && event.contentIds.length ? { contents: event.contentIds.map((id) => ({ content_id: id })) } : {}),
          },
        },
      ],
    });
  },

  snapchat({ pixel, token }, event) {
    const b = event.browser || {};
    return snapchatCapi.call(pixel.pixelId, token, {
      data: [
        {
          event_name: NAMES[event.name].snapchat,
          event_time: seconds(event.occurredAt),
          event_id: event.eventId,
          action_source: 'WEB',
          ...(event.url ? { event_source_url: event.url } : {}),
          user_data: {
            ...(event.clientIp ? { client_ip_address: event.clientIp } : {}),
            ...(event.userAgent ? { client_user_agent: event.userAgent } : {}),
            ...(b.scCid ? { sc_click_id: b.scCid } : {}),
          },
          custom_data: {
            ...money(event),
            ...(event.contentIds && event.contentIds.length ? { content_ids: event.contentIds } : {}),
            ...(event.numItems ? { num_items: String(event.numItems) } : {}),
          },
        },
      ],
    });
  },

  google({ pixel, token }, event) {
    return googleMp.call(pixel.pixelId, token, {
      // GA4 has no browser id here (the storefront does not read `_ga`): a
      // stable pseudo id per visitor, as sendPurchase does per order.
      client_id: googleMp.pseudoClientId(event.visitorId || event.eventId),
      events: [
        {
          name: NAMES[event.name].google,
          params: {
            ...money(event),
            ...(event.contentIds && event.contentIds.length ? { items: event.contentIds.map((id) => ({ item_id: id })) } : {}),
            ...(event.url ? { page_location: event.url } : {}),
            event_id: event.eventId,
          },
        },
      ],
    });
  },
  // Per ad account (pixel.config.adAccountId); sandbox until PINTEREST_CAPI_MODE=live (pinterestCapi.js).
  pinterest({ pixel, token }, event) {
    const name = NAMES[event.name].pinterest;
    if (!name) return null;
    const pinterestCapi = require('./pinterestCapi');
    return pinterestCapi.call(
      (pixel.config || {}).adAccountId,
      token,
      {
        data: [
          {
            event_name: name,
            action_source: 'web',
            event_time: seconds(event.occurredAt),
            event_id: String(event.eventId),
            ...(event.url ? { event_source_url: event.url } : {}),
            user_data: {
              ...(event.clientIp ? { client_ip_address: event.clientIp } : {}),
              ...(event.userAgent ? { client_user_agent: event.userAgent } : {}),
              ...(event.visitorId ? { external_id: [pinterestCapi.sha256(event.visitorId)] } : {}),
            },
            custom_data: {
              ...(money(event).currency ? { currency: event.currency, value: String(Number(event.valueMinor) / 100) } : {}),
              ...(event.contentIds && event.contentIds.length ? { content_ids: event.contentIds.map(String) } : {}),
              ...(event.numItems ? { num_items: event.numItems } : {}),
            },
          },
        ],
      },
      { test: Boolean(pixel.testEventCode) }
    );
  },
  // Reddit, Microsoft and X (sandbox until their *_CAPI_MODE=live). Names as the browser tags use them.
  reddit({ pixel, token }, event) {
    const name = require('../browserPixelEvents').NAMES.reddit[event.name];
    if (!name) return null;
    const reddit = require('./redditCapi');
    const b = event.browser || {};
    return reddit.call(pixel.pixelId, token, reddit.eventBody({ trackingType: name, occurredAt: event.occurredAt, conversionId: event.eventId, clickId: b.rdt_cid, currency: event.currency, valueMinor: event.valueMinor, itemCount: event.numItems, productIds: event.contentIds, externalId: event.visitorId, clientIp: event.clientIp, userAgent: event.userAgent, test: Boolean(pixel.testEventCode) }));
  },
  microsoft({ pixel, token }, event) {
    const name = require('../browserPixelEvents').NAMES.microsoft[event.name];
    if (name === undefined) return null;
    const ms = require('./microsoftCapi');
    const b = event.browser || {};
    // page_view has no name: it goes as UET's pageLoad.
    return ms.call(pixel.pixelId, token, ms.eventBody({ eventName: name, eventId: event.eventId, occurredAt: event.occurredAt, url: event.url, msclkid: b.msclkid, currency: event.currency, valueMinor: event.valueMinor, itemIds: event.contentIds, externalId: event.visitorId, clientIp: event.clientIp, userAgent: event.userAgent }));
  },
  x({ pixel, token }, event) {
    const xEventId = ((pixel.config || {}).eventIds || {})[event.name];
    const b = event.browser || {};
    // X needs an identifier: without its click id, an anonymous event can't be sent.
    if (!xEventId || !b.twclid) return null;
    const x = require('./xCapi');
    return x.call(pixel.pixelId, token, x.conversionBody({ eventId: xEventId, conversionId: event.eventId, occurredAt: event.occurredAt, twclid: b.twclid, currency: event.currency, valueMinor: event.valueMinor }));
  },
};

/** Sends one event to one pixel. `target` is { pixel, token } from trackingPixelService.serverPixelsFor. */
function send(target, event) {
  const sender = SENDERS[target.pixel.platform];
  if (!sender || !NAMES[event.name]) return null;
  return sender(target, event);
}

module.exports = { NAMES, EVENT_NAMES, send };
