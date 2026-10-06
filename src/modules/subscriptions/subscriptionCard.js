'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const service = require('./subscriptionService');

/**
 * The customer's portal: replace the card a subscription is charged to (SPEC
 * §18.1, "update the card via a signed link"). The portal link is what the
 * "renewal failed" message sends (automationContext {{payment_link}}).
 *
 * The customer is sent to the payment provider's own "save a card" page
 * (payments/savedMethods/cardSetup.js) and comes back to the portal. The new
 * card replaces the old one; a subscription waiting on a failed renewal is
 * charged on it at once, with a fresh retry schedule if that fails too.
 *
 * Codes: SUBSCRIPTION_ENDED (409), CARD_SETUP_NOT_SUPPORTED (422),
 * CARD_SETUP_NOT_STARTED (409), CARD_NOT_SAVED (422).
 */

const ENDED = ['cancelled', 'completed'];

async function cardOf(sub) {
  if (!sub.savedPaymentMethodId) return null;
  const saved = await db.PaymentMethodSaved.findOne({ where: { id: sub.savedPaymentMethodId, workspaceId: sub.workspaceId } });
  return saved ? { brand: saved.brand, last4: saved.last4, expiresAt: saved.expiresAt, provider: saved.providerCode } : null;
}

/** The portal view, with the card on file and whether it can be replaced here. */
async function portalView(sub) {
  const card = await cardOf(sub);
  return {
    ...service.portalView(sub),
    card: card ? { brand: card.brand, last4: card.last4, expiresAt: card.expiresAt } : null,
    canUpdateCard: !ENDED.includes(sub.status),
  };
}

async function portalGet(workspaceId, token) {
  return { subscription: await portalView(await service.byToken(workspaceId, token)) };
}

async function portalCancel(workspaceId, token) {
  await service.portalCancel(workspaceId, token);
  return portalGet(workspaceId, token);
}

/** Where to send the customer to give a new card. `returnUrl` is the portal page. */
async function startUpdate(workspaceId, token, { returnUrl }) {
  const sub = await service.byToken(workspaceId, token);
  if (ENDED.includes(sub.status)) throw new AppError('SUBSCRIPTION_ENDED', 'This subscription has already ended', 409);
  const url = await require('../payments/onlinePaymentService').assertReturnUrl(workspaceId, returnUrl);
  const cardSetup = require('../payments/savedMethods/cardSetup');
  // The gateway of the card on file, or else the one the first order was paid with.
  const current = await cardOf(sub);
  const firstPayment = current
    ? null
    : await db.Payment.findOne({ where: { workspaceId, orderId: sub.orderId, status: ['captured', 'partially_refunded'] }, order: [['createdAt', 'DESC']] });
  const provider = await cardSetup.providerFor(workspaceId, (current && current.provider) || (firstPayment && firstPayment.providerCode));
  if (!provider) throw new AppError('CARD_SETUP_NOT_SUPPORTED', 'This store cannot take a new card here yet. Contact the store.', 422);
  const reference = `subcard_${crypto.randomBytes(9).toString('hex')}`;
  const setup = await cardSetup.start(workspaceId, { provider, reference, returnUrl: url });
  await sub.update({ cardSetup: { provider, reference, startedAt: new Date().toISOString() } });
  return { redirectUrl: setup.redirectUrl };
}

/** The customer came back from the provider's page with `query` (its redirect's query string). */
async function finishUpdate(workspaceId, token, { query }) {
  const sub = await service.byToken(workspaceId, token);
  const pending = sub.cardSetup;
  if (!pending || !pending.reference) throw new AppError('CARD_SETUP_NOT_STARTED', 'There is no card update to finish', 409);
  const saved = await require('../payments/savedMethods/cardSetup').finish(workspaceId, {
    provider: pending.provider,
    reference: pending.reference,
    query,
    customerId: sub.customerId,
  });
  const before = { savedPaymentMethodId: sub.savedPaymentMethodId, status: sub.status };
  const due = sub.status === 'past_due';
  await sub.update({
    savedPaymentMethodId: saved.id,
    cardSetup: null,
    // A failed renewal is charged on the new card right away, with a fresh retry schedule.
    ...(due ? { nextRenewalAt: new Date(), failedAttempts: 0 } : {}),
  });
  await recordAudit({
    workspaceId,
    actorUserId: null,
    action: 'subscription.card_update_by_customer',
    entityType: 'CustomerSubscription',
    entityId: sub.id,
    before,
    after: { savedPaymentMethodId: saved.id },
  });
  const renewal = due ? await service.renewOne(sub.id) : null;
  const fresh = await db.CustomerSubscription.findByPk(sub.id);
  return { subscription: await portalView(fresh), renewal };
}

module.exports = { portalGet, portalCancel, startUpdate, finishUpdate };
