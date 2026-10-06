'use strict';

const db = require('../../../db/models');

/*
 * Sample payloads for Zapier / Make (spec-gaps item 193): when a merchant
 * sets up a trigger, the automation tool asks for a few examples to map
 * fields from. These are the store's latest real events of that kind, built
 * exactly as a delivery would be (webhookFanout.build), newest first; with
 * none yet, one sample of the same shape marked `sample: true`.
 */

const { DOMAIN_TO_TOPIC } = require('../../webhooks/webhookTopics');
const { EVENT_TYPES } = require('../../webhooks/webhookEvents');
// The two topics the order change detector sends, and the domain events that stand for them.
const DETECTOR = { 'order.created': ['order.created'], 'order.status_changed': ['order.confirmed', 'order.shipped', 'order.delivered', 'order.cancelled'] };

const SAMPLE_ORDER = {
  id: '00000000-0000-4000-8000-000000000001', orderNumber: 'ORD-SAMPLE-1', status: 'placed', currency: 'EGP',
  contact: { fullName: 'Sample Customer', phone: '+201000000000', email: 'customer@example.com' },
  shippingAddress: { country: 'EG', province: 'القاهرة', city: 'مدينة نصر', addressLine: '1 Sample St' },
  items: [{ sku: 'SKU-1', name: 'Sample product', quantity: 1, unitPrice: 25000, lineTotal: 25000 }],
  amounts: { subtotal: 25000, shipping: 5000, discount: 0, total: 30000 }, paymentMethod: 'cod', createdAt: new Date().toISOString(),
};
const SAMPLE_CONTACT = { id: '00000000-0000-4000-8000-000000000002', fullName: 'Sample Lead', phoneNormalized: '201000000000', email: 'lead@example.com', tags: ['sample'], marketingConsent: true };

function fallback(topic) {
  const [aggregate] = topic.split('.');
  if (aggregate === 'order' || aggregate === 'payment') return { order: SAMPLE_ORDER };
  if (['customer', 'contact', 'lead'].includes(aggregate)) return { customer: SAMPLE_CONTACT, contact: SAMPLE_CONTACT };
  if (aggregate === 'product') return { product: { id: '00000000-0000-4000-8000-000000000003', name: 'Sample product', status: 'active', variants: [] } };
  return { sample: true };
}

async function samples(workspaceId, topic, limit = 3) {
  if (!EVENT_TYPES[topic]) return null;
  const domainTypes = DETECTOR[topic] || Object.entries(DOMAIN_TO_TOPIC).filter(([, t]) => t === topic).map(([d]) => d);
  const { build } = require('../../webhooks/webhookFanout');
  const rows = domainTypes.length
    ? await db.sequelize.query(
      `SELECT id, workspace_id AS "workspaceId", type, payload, occurred_at AS "occurredAt" FROM domain_events
        WHERE workspace_id = :workspaceId AND type IN (:types) ORDER BY occurred_at DESC LIMIT 20`,
      { replacements: { workspaceId, types: domainTypes }, type: db.Sequelize.QueryTypes.SELECT }
    )
    : [];
  const out = [];
  for (const e of rows) {
    if (out.length >= limit) break;
    const built = build ? await build(topic, { ...e, workspaceId }).catch(() => null) : null;
    if (built) out.push({ id: `${topic}:${e.id}`, type: topic, createdAt: new Date(e.occurredAt).toISOString(), workspaceId, data: built.data });
  }
  if (!out.length) out.push({ id: `${topic}:sample`, type: topic, createdAt: new Date().toISOString(), workspaceId, sample: true, data: fallback(topic) });
  return out;
}

module.exports = { samples };
