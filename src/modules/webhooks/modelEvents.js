'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/*
 * Domain events for webhook topics that no service records (item 178):
 *
 *   funnel.created / funnel.updated / funnel.deleted   a funnel row's life
 *   payment.paid                                       a payment reaches "captured"
 *   contact.updated                                    a contact's own details change
 *
 * Recorded in the outbox inside the change's transaction (model hooks), so
 * the webhook goes out only if the change commits, like every other topic.
 */

const outbox = () => require('../../core/outbox/outbox');
const record = (options, type, payload) =>
  outbox()
    .record(options && options.transaction ? options.transaction : null, type, payload)
    .catch((err) => logger.error(`[webhooks] could not record ${type}: ${err.message}`));

// A contact's own details, not counters the store keeps about it.
const CONTACT_FIELDS = ['fullName', 'email', 'phone', 'tags', 'notes', 'acceptsMarketing', 'marketingConsent', 'address', 'city', 'governorate', 'country'];
// After a save, Sequelize has already reset changed()/previous(): `options.fields` names what was written.
const saved = (options, field) => Boolean(options && Array.isArray(options.fields) && options.fields.includes(field));

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  db.Funnel.addHook('afterCreate', 'zimosWebhookTopics', (f, o) => record(o, 'funnel.created', { workspaceId: f.workspaceId, funnelId: f.id }));
  db.Funnel.addHook('afterUpdate', 'zimosWebhookTopics', (f, o) => record(o, 'funnel.updated', { workspaceId: f.workspaceId, funnelId: f.id }));
  // Deleting moves a funnel to the trash (modules/trash): it stops serving then, so that is when
  // funnel.deleted fires (trashed: true). Purging it later sends nothing more; a restore is an update.
  db.Funnel.addHook('afterDestroy', 'zimosWebhookTopics', (f, o) =>
    o && o.force ? null : record(o, 'funnel.deleted', { workspaceId: f.workspaceId, funnelId: f.id, name: f.name, subdomain: f.subdomain || null, trashed: true })
  );
  db.Funnel.addHook('afterRestore', 'zimosWebhookTopics', (f, o) => record(o, 'funnel.updated', { workspaceId: f.workspaceId, funnelId: f.id }));
  const paid = (p, o) => record(o, 'payment.paid', { workspaceId: p.workspaceId, paymentId: p.id, orderId: p.orderId });
  db.Payment.addHook('afterCreate', 'zimosWebhookTopics', (p, o) => (p.status === 'captured' ? paid(p, o) : null));
  db.Payment.addHook('afterUpdate', 'zimosWebhookTopics', (p, o) =>
    p.status === 'captured' && saved(o, 'status') ? paid(p, o) : null
  );
  const attrs = Object.keys(db.Customer.rawAttributes);
  const fields = CONTACT_FIELDS.filter((f) => attrs.includes(f));
  db.Customer.addHook('afterUpdate', 'zimosWebhookTopics', (c, o) =>
    fields.some((field) => saved(o, field)) ? record(o, 'contact.updated', { workspaceId: c.workspaceId, customerId: c.id }) : null
  );
}

install();

module.exports = { install };
