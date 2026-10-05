'use strict';

const db = require('../../db/models');

/**
 * Automation conditions (SPEC §14.2) on the triggers that carry no order
 * (automationContext.conditionsFail handles orders): a lost or abandoned
 * checkout (`checkout.abandoned`, `lost_order.created`), a lead
 * (`lead.created`) and a subscription (`subscription.renewal_failed`).
 *
 * Each condition is read from what the subject has:
 *
 *   condition       checkout                   lead                 subscription
 *   paymentMethod   the refused checkout's     —                    card (renewals charge a saved card)
 *   minTotalAmount  the lines' subtotal        —                    the period's amount
 *   productIds      its lines                  —                    its product
 *   governorates    the address typed          —                    —
 *   source          store / funnel             funnel or not        —
 *   funnelIds       the refused checkout's     —                    —
 *   riskLevel       low (a checkout is not scored)
 *   tags            the contact's tags (all three)
 *   isFirstOrder    the contact has no order yet (all three)
 *
 * A condition the subject cannot answer ("—", or a checkout autosaved before
 * a payment method was picked) skips the rule with that reason, rather than
 * sending a message the merchant limited to something else. Null when the
 * rule applies; otherwise why it was skipped.
 */

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);
const set = (value) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0) && value !== '';

async function contactOf(subject) {
  if (subject.customer) return subject.customer;
  if (subject.kind !== 'checkout') return null;
  const { session } = subject;
  if (!session.phoneNormalized) return null;
  return db.Customer.findOne({ where: { workspaceId: session.workspaceId, phoneNormalized: session.phoneNormalized } });
}

/** What the subject says for each condition; undefined = it cannot say. */
function factsOf(subject) {
  if (subject.kind === 'checkout') {
    const { session } = subject;
    const payload = session.checkoutPayload || {};
    const contact = session.contactFields || {};
    const address = payload.shippingAddress || {};
    return {
      paymentMethod: payload.paymentMethod || undefined,
      total: Number(session.subtotalAmount),
      productIds: (Array.isArray(session.items) ? session.items : []).map((i) => i.productId).filter(Boolean),
      places: [address.province, address.city, contact.province, contact.city].filter(Boolean),
      source: session.source === 'funnel' ? 'funnel' : 'store',
      funnelId: payload.funnelId || undefined,
    };
  }
  // A lead.
  return { source: subject.customer && subject.customer.source === 'funnel' ? 'funnel' : 'store' };
}

const SUBJECT = { checkout: 'this checkout', customer: 'a lead' };
const cannot = (name, kind) => `${SUBJECT[kind] || 'this'} has no ${name} to check`;

async function fails(conditions, subject) {
  const c = conditions && !Array.isArray(conditions) ? conditions : {};
  const facts = factsOf(subject);
  const kind = subject.kind;

  if (set(c.paymentMethod)) {
    if (facts.paymentMethod === undefined) return cannot('payment method', kind);
    if (facts.paymentMethod !== c.paymentMethod) return `payment method is ${facts.paymentMethod}`;
  }
  if (set(c.minTotalAmount)) {
    if (facts.total === undefined || Number.isNaN(facts.total)) return cannot('minimum total', kind);
    if (facts.total < Number(c.minTotalAmount)) return 'total below the minimum';
  }
  const productIds = asList(c.productIds);
  if (productIds.length) {
    if (!facts.productIds) return cannot('products', kind);
    if (!facts.productIds.some((id) => productIds.includes(id))) return 'none of the chosen products is in it';
  }
  const governorates = asList(c.governorates).map((g) => String(g).trim().toLowerCase());
  if (governorates.length) {
    if (!facts.places) return cannot('governorates', kind);
    const places = facts.places.map((p) => String(p).trim().toLowerCase());
    if (!places.some((p) => governorates.includes(p))) return 'governorate is not in the list';
  }
  if (c.source === 'funnel' || c.source === 'store') {
    if (!facts.source) return cannot('source', kind);
    if (facts.source !== c.source) return `it came from the ${facts.source === 'funnel' ? 'funnel' : 'store'}`;
  }
  const funnelIds = asList(c.funnelIds);
  if (funnelIds.length) {
    if (facts.funnelId === undefined) return cannot('funnels', kind);
    if (!funnelIds.includes(facts.funnelId)) return 'not from one of the chosen funnels';
  }
  const riskLevels = asList(c.riskLevel);
  if (riskLevels.length && !riskLevels.includes('low')) return 'risk level is low';

  const tags = asList(c.tags).map((t) => String(t).toLowerCase());
  const wantsFirst = typeof c.isFirstOrder === 'boolean';
  if (tags.length || wantsFirst) {
    const contact = await contactOf(subject);
    if (tags.length) {
      const has = ((contact && contact.tags) || []).map((t) => String(t).toLowerCase());
      if (!tags.some((t) => has.includes(t))) return 'the contact has none of the tags';
    }
    if (wantsFirst) {
      const orders = contact ? await db.Order.count({ where: { workspaceId: contact.workspaceId, customerId: contact.id } }) : 0;
      if (c.isFirstOrder && orders > 0) return 'the contact has ordered before';
      if (!c.isFirstOrder && orders === 0) return 'the contact has not ordered yet';
    }
  }
  return null;
}

module.exports = { fails };
