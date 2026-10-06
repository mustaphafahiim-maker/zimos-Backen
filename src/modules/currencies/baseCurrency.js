'use strict';

const asyncHandler = require('express-async-handler');
const Joi = require('joi');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * The store's own currency (SPEC §8.8, §11.5: "cannot be changed after the
 * first order"): what its prices are written in and its orders are taken in.
 *
 * Set from the dashboard until the store's first order. Changing it rewrites
 * the currency of every variant and offer the store has (their amounts stay
 * as the merchant typed them — a new store is still being set up), drops it
 * from the display currencies, and is audited (entityType Workspace, so the
 * storefront's cache drops). A variant or offer created without a currency
 * takes the store's (storeCurrency).
 */

/** The store's currency, for a price created without one. */
async function storeCurrency(workspaceId, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'], transaction });
  return (workspace && workspace.defaultCurrency) || 'EGP';
}

async function setBaseCurrency(workspaceId, currency, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = workspace.defaultCurrency || 'EGP';
    if (before === currency) return { baseCurrency: before, changed: false };
    const orders = await db.Order.count({ where: { workspaceId }, transaction });
    if (orders > 0) throw new AppError('BASE_CURRENCY_LOCKED', 'The store currency cannot change once the store has taken an order', 409);

    const [variants] = await db.ProductVariant.update({ currency }, { where: { workspaceId }, transaction });
    const [offers] = await db.Offer.update({ currency }, { where: { workspaceId }, transaction });
    const settings = { ...(workspace.settings || {}) };
    if (settings.currencies && Array.isArray(settings.currencies.display)) {
      settings.currencies = { ...settings.currencies, display: settings.currencies.display.filter((c) => c !== currency) };
    }
    await workspace.update({ defaultCurrency: currency, settings }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'currencies.base_change',
      entityType: 'Workspace',
      entityId: workspaceId,
      before: { baseCurrency: before },
      after: { baseCurrency: currency, variants, offers },
      req,
      transaction,
    });
    return { baseCurrency: currency, changed: true };
  });
}

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  body: Joi.object({ currency: Joi.string().trim().uppercase().length(3).pattern(/^[A-Z]{3}$/).required() }),
};

// PUT /workspaces/:ws/currencies/base { currency }
const handler = asyncHandler(async (req, res) => {
  const fx = require('./fxService');
  const known = new Set([...(await fx.getForDashboard(req.tenant.workspaceId)).availableCurrencies, 'EGP', 'SAR', 'AED', 'USD']);
  if (!known.has(req.body.currency)) {
    throw new ValidationError([{ field: 'currency', message: `Unknown currency ${req.body.currency}` }], 'Unknown currency');
  }
  await setBaseCurrency(req.tenant.workspaceId, req.body.currency, req);
  res.json({ currencies: await fx.getForDashboard(req.tenant.workspaceId) });
});

module.exports = { storeCurrency, setBaseCurrency, schema, handler };
