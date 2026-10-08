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
  'order.item_added': 'A product was added to an order after it was placed (an upsell, or an edit by the team).',
  'shipment.status_changed': 'A shipment moved to another status (old_status and new_status are in the payload).',
  'checkout.created': 'A shopper started a checkout.',
  'checkout.updated': 'A shopper changed their checkout details.',
  'checkout.abandoned': 'A checkout was left without an order.',
  'customer.created': 'A new customer was recorded.',
  'customer.updated': "A customer's details were edited.",
  'lead.created': 'A new lead was captured.',
  'contact_form.submitted': 'A contact form was submitted.',
  'product.created': 'A product was added.',
  'product.updated': 'A product was edited.',
  'product.deleted': 'A product was archived.',
  'product.low_stock': "A variant's available stock fell to its low-stock threshold (variantId, available and threshold are in the payload).",
  'review.created': 'A product review was submitted by a customer or added by the team.',
  'funnel.published': 'A funnel was published.',
  // Item 178 (webhooks/modelEvents.js).
  'funnel.created': 'A funnel was created.',
  'funnel.updated': 'A funnel was edited (its settings, steps map, status or name).',
  'funnel.deleted': 'A funnel was deleted: moved to the trash, where it can still be restored (its id and name are in the payload).',
  'payment.paid': 'A payment was received for an order (online, a transfer that was accepted, or cash collected).',
  'contact.updated': "A contact's details, tags or marketing consent were changed.",
  // Item 372 (returns/): the return, with its order.
  'return.requested': 'A return or exchange was asked for, by the shopper or by the team (source and resolution are in the payload).',
  'return.approved': 'A return or exchange was approved (an exchange carries its replacement order id).',
  'return.rejected': 'A return or exchange was rejected.',
  'return.received': 'A returned parcel came back to the store: the courier handed it back (source courier) or the team restocked it. Units are back in stock only after the restock step, which may come later.',
});

const DOMAIN_TO_TOPIC = Object.freeze({
  'order.updated': 'order.updated',
  'order.confirmed': 'order.confirmed',
  'order.delivered': 'order.fulfilled',
  'order.cancelled': 'order.cancelled',
  'order.uncancelled': 'order.uncancelled',
  'order.paid': 'order.paid',
  'order.refunded': 'order.refunded',
  'order.item_added': 'order.item_added',
  'shipment.status_changed': 'shipment.status_changed',
  'checkout.started': 'checkout.created',
  'checkout.created': 'checkout.created',
  'checkout.updated': 'checkout.updated',
  'checkout.abandoned': 'checkout.abandoned',
  'customer.created': 'customer.created',
  'customer.updated': 'customer.updated',
  'lead.created': 'lead.created',
  'contact_form.submitted': 'contact_form.submitted',
  'product.created': 'product.created',
  'product.updated': 'product.updated',
  'product.deleted': 'product.deleted',
  'product.low_stock': 'product.low_stock',
  'review.created': 'review.created',
  'funnel.published': 'funnel.published',
  'funnel.created': 'funnel.created',
  'funnel.updated': 'funnel.updated',
  'funnel.deleted': 'funnel.deleted',
  'payment.paid': 'payment.paid',
  'contact.updated': 'contact.updated',
  'return.requested': 'return.requested',
  'return.approved': 'return.approved',
  'return.rejected': 'return.rejected',
  'return.received': 'return.received',
});

// The model hooks that record the funnel, payment and contact events (item 178).
require('./modelEvents');

module.exports = { TOPICS, DOMAIN_TO_TOPIC };
