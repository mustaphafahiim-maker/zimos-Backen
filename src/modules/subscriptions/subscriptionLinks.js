'use strict';

const db = require('../../db/models');

/**
 * The customer's way into their subscription page (SPEC §18.1: "a signed
 * link sent to them by email/WhatsApp"): the portal at
 * /subscriptions/<portal token> on the store, where they see the
 * subscription, change the card or cancel. The token is the credential.
 *
 * It reaches them three ways:
 *   - the "Subscription started" order email (orderEmailService, on
 *     subscription.created — on unless the store turns it off), as
 *     {{subscription_link}};
 *   - the ready WhatsApp automation "Subscription started" (automationTemplates);
 *   - the order's tracking page, for the order that started it.
 */

const pathFor = (sub) => (sub && sub.portalToken ? `/subscriptions/${sub.portalToken}` : null);

/** The subscriptions an order started, as the tracking page shows them. */
async function forTrackedOrder(workspaceId, orderId) {
  const rows = await db.CustomerSubscription.findAll({
    where: { workspaceId, orderId },
    attributes: ['id', 'productName', 'status', 'kind', 'portalToken'],
    order: [['createdAt', 'ASC']],
  });
  return rows.map((s) => ({ productName: s.productName, status: s.status, kind: s.kind, portalPath: pathFor(s) }));
}

module.exports = { pathFor, forTrackedOrder };
