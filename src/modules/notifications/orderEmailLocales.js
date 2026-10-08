'use strict';

const db = require('../../db/models');

/**
 * Order emails per language (item 383).
 *
 * A store's email has a default version (rows with `locale` null — every
 * row from before) and may have one version per other language it offers
 * (`locale` 'en', 'fr', …). The store's own default language is the default
 * version, so `?locale=<the store's language>` edits the default version.
 *
 * Which text goes out for an order in language L:
 *
 *   1. L's version, when the store wrote one (a funnel's or website's L
 *      version first, then the store's) — a field it left empty is the
 *      built-in text in L, else the default version's;
 *   2. else the default version, when the merchant changed it;
 *   3. else the built-in text in L (Arabic and English exist), else the
 *      built-in text in the store's language.
 *
 * The language beats a funnel's or website's override: an English shopper
 * of a funnel with an Arabic override and a store-wide English version gets
 * the English one. On/off is one switch per email (and per funnel or website
 * override), kept on its default version; a language version only holds text.
 */

// The built-in texts in English; the Arabic ones are orderEmailService.TEMPLATES.
const EN = Object.freeze({
  order_confirmation: {
    subject: 'We received your order {{order_number}}',
    body: 'Hi {{customer_name}},\n\nThank you for your order from {{store_name}}. We received your order {{order_number}} for {{order_total}}.\n\nItems: {{product_names}}\n\nFollow your order here:\n{{order_link}}',
  },
  order_shipped: {
    subject: 'Your order {{order_number}} is on its way',
    body: 'Hi {{customer_name}},\n\nYour order {{order_number}} has shipped with {{carrier_name}}.\nTracking number: {{waybill_number}}\n\nFollow the shipment here:\n{{order_link}}',
  },
  order_cancelled: {
    subject: 'Your order {{order_number}} was cancelled',
    body: 'Hi {{customer_name}},\n\nYour order {{order_number}} from {{store_name}} was cancelled. If that was a mistake, we would be glad to take your order again.',
  },
  order_refunded: {
    subject: 'Your order {{order_number}} was refunded',
    body: 'Hi {{customer_name}},\n\nThe amount of your order {{order_number}} was refunded. It may take a few business days to show in your account, depending on how you paid.',
  },
  abandoned_cart: {
    subject: 'Your order from {{store_name}} is waiting for you',
    body: 'Hi {{customer_name}},\n\nWe noticed you did not finish your order from {{store_name}}. It is still saved, and you can complete it here:\n{{recovery_link}}',
  },
  transfer_rejected: {
    subject: 'We could not confirm the transfer for your order {{order_number}}',
    body: 'Hi {{customer_name}},\n\nWe could not confirm the transfer for your order {{order_number}} from {{store_name}}.\n\nYou can upload a new receipt here:\n{{order_link}}',
  },
  subscription_started: {
    subject: 'Your subscription to {{product_name}} is active',
    body: 'Hi {{customer_name}},\n\nThank you for subscribing to {{product_name}} from {{store_name}} ({{order_total}}).\n\nOn your subscription page you can follow it, change the card it is charged to, or cancel at any time:\n{{subscription_link}}',
  },
  return_approved: {
    subject: 'Your return request for order {{order_number}} was approved',
    body: 'Hi {{customer_name}},\n\n{{store_name}} approved your return or exchange request for order {{order_number}}.\n\nSee the details and the next step here:\n{{order_link}}',
  },
  return_rejected: {
    subject: 'About your return request for order {{order_number}}',
    body: 'Hi {{customer_name}},\n\nUnfortunately {{store_name}} could not accept your return or exchange request for order {{order_number}}.\n\nYou will find the reason and the details here:\n{{order_link}}',
  },
  digital_delivery: {
    subject: 'Your digital product from {{store_name}} is ready',
    body: 'Hi {{customer_name}},\n\nThank you for your order {{order_number}}. You can reach your digital purchases here:\n{{order_link}}',
  },
});

const SAMPLE_VARS_EN = Object.freeze({
  customer_name: 'Mona Ahmed',
  city: 'Cairo',
  product_names: 'Blue linen shirt, Leather belt',
});
const SAMPLE_LINES_EN = Object.freeze({
  lines: [
    { name: 'Blue linen shirt', quantity: 1, total: '600 EGP' },
    { name: 'Leather belt', quantity: 1, total: '200 EGP' },
  ],
  totals: { shipping: '50 EGP', total: '850 EGP' },
});

/** The built-in { subject, body } of `key` in `lang`, or null when there is none in it. */
function builtIn(templates, key, lang) {
  if (lang === 'ar') return { subject: templates[key].subject, body: templates[key].body };
  if (lang === 'en' && EN[key]) return EN[key];
  return null;
}

/**
 * The store's languages and the version `asked` names: { locale (null = the
 * default version), defaultLocale, languages }. An `asked` the store does not
 * offer is a 422 (orders/orderLocale.assertOffered).
 */
async function languageOf(workspaceId, asked) {
  const orderLocale = require('../orders/orderLocale');
  const workspace = await orderLocale.loadWorkspace(workspaceId);
  const { defaultLocale, languages } = require('../translations/translations').languagesOf(workspace || {});
  const base = asked ? orderLocale.assertOffered(workspace || {}, asked) : null;
  return { locale: base && base !== defaultLocale ? base : null, defaultLocale, languages };
}

/** For a send: the order's language when the store still offers it besides its own, else null (the default version). */
async function sendingLanguage(workspaceId, locale) {
  const workspace = await require('../orders/orderLocale').loadWorkspace(workspaceId);
  const { defaultLocale, languages } = require('../translations/translations').languagesOf(workspace || {});
  const base = require('../orders/orderLocale').baseOf(locale);
  return { locale: base && base !== defaultLocale && languages.includes(base) ? base : null, defaultLocale, languages };
}

/** The language of what an email is about: the order's, the checkout's, a subscription's first order's. */
async function localeOfSubject(subject) {
  if (!subject) return null;
  if (subject.order) return subject.order.locale || null;
  if (subject.session) return subject.session.locale || null;
  if (subject.subscription && subject.subscription.orderId) {
    const first = await db.Order.findByPk(subject.subscription.orderId, { attributes: ['locale'] });
    return first ? first.locale : null;
  }
  return null;
}

const rowLocale = (r) => (r && r.locale) || null;

module.exports = { EN, SAMPLE_VARS_EN, SAMPLE_LINES_EN, builtIn, languageOf, sendingLanguage, localeOfSubject, rowLocale };
