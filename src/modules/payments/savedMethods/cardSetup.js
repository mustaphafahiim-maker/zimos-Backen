'use strict';

const db = require('../../../db/models');
const { AppError } = require('../../../core/errors/AppError');
const secretBox = require('../../../core/utils/secretBox');
const { recordAudit } = require('../../audit/auditService');
const gateways = require('../gateways');
const gatewayRuntime = require('../gatewayRuntime');

/**
 * Saving a card with no payment (README.md, "Saving a card without a
 * payment"): a subscription's card update from the customer's portal, and a
 * free trial with nothing to pay now (SPEC §18.1). The gateway's own page
 * asks for the card; what comes back is a token, stored like any saved card
 * (no source payment, or the trial's zero payment).
 */

function supports(adapter) {
  return Boolean(adapter && adapter.supportsTokenization && adapter.createCardSetup && adapter.completeCardSetup);
}

/**
 * The gateway to save a card with: `preferred` (the one the customer already
 * paid with) when it can, otherwise the first live account that can. A test
 * gateway is only used when it is the preferred one — a shopper of a live
 * store never saves a card that charges nothing.
 */
async function providerFor(workspaceId, preferred) {
  const accounts = await db.PaymentGatewayAccount.findAll({ where: { workspaceId, status: 'active' }, order: [['createdAt', 'ASC']] });
  const usable = accounts.filter((a) => supports(gateways.getAdapter(a.providerCode)));
  const pick = usable.find((a) => a.providerCode === preferred) || usable.find((a) => a.mode === 'live');
  return pick ? pick.providerCode : null;
}

async function contextFor(workspaceId, provider) {
  const ctx = await gatewayRuntime.contextFor(workspaceId, provider);
  if (!supports(ctx.adapter)) throw new AppError('CARD_SETUP_NOT_SUPPORTED', 'This payment provider cannot save a card without a payment', 422);
  return ctx;
}

/** Where to send the customer to give their card. */
async function start(workspaceId, { provider, reference, returnUrl }) {
  const ctx = await contextFor(workspaceId, provider);
  const result = await ctx.adapter.createCardSetup(ctx.credentials, {
    workspaceId,
    reference,
    returnUrl,
    webhookUrl: ctx.account.webhookUrl,
    settings: ctx.settings,
  });
  if (!result || !result.redirectUrl) throw new AppError('CARD_SETUP_FAILED', 'The payment provider could not open its card page', 424);
  return { redirectUrl: result.redirectUrl, mode: ctx.mode };
}

/** The customer came back: saves the card they gave, or throws CARD_NOT_SAVED. */
async function finish(workspaceId, { provider, reference, query, customerId, sourcePaymentId = null }, transaction) {
  const ctx = await contextFor(workspaceId, provider);
  const tokenized = await ctx.adapter.completeCardSetup(ctx.credentials, { workspaceId, reference, query, settings: ctx.settings });
  if (!tokenized || !tokenized.token) throw new AppError('CARD_NOT_SAVED', 'The card was not saved', 422);
  const row = await db.PaymentMethodSaved.create(
    {
      workspaceId,
      customerId,
      providerCode: provider,
      tokenSealed: secretBox.seal(tokenized.token),
      brand: tokenized.brand || null,
      last4: tokenized.last4 ? String(tokenized.last4).slice(-4) : null,
      expiresAt: tokenized.expiresAt || null,
      sourcePaymentId,
    },
    { transaction }
  );
  await recordAudit({
    workspaceId,
    actorUserId: null,
    action: 'saved_payment_method.create',
    entityType: 'PaymentMethodSaved',
    entityId: row.id,
    after: { customerId, provider, last4: row.last4, via: 'card_setup' },
    transaction,
  });
  return row;
}

module.exports = { supports, providerFor, start, finish };
