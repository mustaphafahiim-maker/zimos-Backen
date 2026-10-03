'use strict';

/**
 * The webhook topics beyond order.created / order.status_changed (SPEC §16.1).
 *
 * Those two come from the order change detector. Everything here comes from
 * the event outbox (core/outbox): a domain event is turned into a webhook
 * event by jobs.js → webhookFanout.js. DOMAIN_TO_TOPIC names which domain
 * event feeds which topic; a domain event not listed sends nothing.
 */

const TOPICS = Object.freeze({
  'order.updated': "An order's contact, address or notes were edited.",
  'order.confirmed': 'A cash-on-delivery order was confirmed with the customer.',
  'order.fulfilled': 'An order was delivered to the customer.',
  'order.cancelled': 'An order was cancelled.',
  'order.uncancelled': 'A cancelled order was reopened.',
  'order.paid': 'An order was paid in full.',
  'order.refunded': 'An order was refunded, fully or in part.',
  'shipment.status_changed': 'A shipment moved to another status (old_status and new_status are in the payload).',
  'checkout.created': 'A shopper started a checkout.',
  'checkout.updated': 'A shopper changed their checkout details.',
  'checkout.abandoned': 'A checkout was left without an order.',
  'customer.created': 'A new customer was recorded.',
  'lead.created': 'A new lead was captured.',
  'contact_form.submitted': 'A contact form was submitted.',
  'product.created': 'A product was added.',
  'product.updated': 'A product was edited.',
  'product.deleted': 'A product was archived.',
  'funnel.published': 'A funnel was published.',
});

const DOMAIN_TO_TOPIC = Object.freeze({
  'order.updated': 'order.updated',
  'order.confirmed': 'order.confirmed',
  'order.delivered': 'order.fulfilled',
  'order.cancelled': 'order.cancelled',
  'order.uncancelled': 'order.uncancelled',
  'order.paid': 'order.paid',
  'order.refunded': 'order.refunded',
  'shipment.status_changed': 'shipment.status_changed',
  'checkout.started': 'checkout.created',
  'checkout.created': 'checkout.created',
  'checkout.updated': 'checkout.updated',
  'checkout.abandoned': 'checkout.abandoned',
  'customer.created': 'customer.created',
  'lead.created': 'lead.created',
  'contact_form.submitted': 'contact_form.submitted',
  'product.created': 'product.created',
  'product.updated': 'product.updated',
  'product.deleted': 'product.deleted',
  'funnel.published': 'funnel.published',
});

module.exports = { TOPICS, DOMAIN_TO_TOPIC };
