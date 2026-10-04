'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { resolveSettings } = require('./geoRedirects');

/**
 * The funnel's currency (SPEC §11.5 "currency per funnel"), set in its
 * settings: the funnel sells in it, and its orders are created and collected
 * in it. Prices are not converted — what a shopper is charged is the price
 * the merchant set, in the currency they set it in (the FX provider is an
 * open decision, and a converted price is rarely the one a merchant wants).
 * So the funnel only publishes when what it sells is priced in its currency:
 * each step's offer, a checkout's order bump and the product a page is built
 * around (its active variants). An order placed on the funnel in another
 * currency (a page edited after publishing) is refused.
 *
 * No currency set: nothing is checked, as before.
 */

const currencyOf = (funnel) => (resolveSettings(funnel).currency || '').toUpperCase() || null;

async function publishProblems(workspaceId, funnel, steps, transaction) {
  const currency = currencyOf(funnel);
  if (!currency) return [];
  const problems = [];
  const mismatch = (step, field, what, found) =>
    problems.push({
      stepKey: step.key,
      field: `steps.${step.key}.${field}`,
      message: `${what} on step "${step.key}" is priced in ${found}, but this funnel sells in ${currency}. Price it in ${currency} (an offer in ${currency}) or change the funnel's currency.`,
    });

  for (const step of steps) {
    for (const [field, id, what] of [
      ['offerId', step.offerId, 'The offer'],
      ['bumpOfferId', step.bumpOfferId, 'The order bump'],
    ]) {
      if (!id) continue;
      const offer = await db.Offer.findOne({ where: { id, workspaceId }, attributes: ['currency'], transaction });
      if (offer && offer.currency && offer.currency !== currency) mismatch(step, field, what, offer.currency);
    }
    const productId = step.builderData && typeof step.builderData === 'object' ? step.builderData.productId : null;
    if (productId) {
      const variants = await db.ProductVariant.findAll({
        where: { workspaceId, productId, status: 'active' },
        attributes: ['currency'],
        transaction,
      });
      const other = variants.map((v) => v.currency).find((c) => c && c !== currency);
      if (other) mismatch(step, 'builderData.productId', 'The page\'s product', other);
    }
  }
  return problems;
}

/** createOrder: an order placed on a funnel is in the funnel's currency (422 otherwise). */
async function assertOrderCurrency(workspaceId, funnelId, orderCurrency, transaction) {
  if (!funnelId) return;
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['id', 'settings'], transaction });
  const currency = funnel ? currencyOf(funnel) : null;
  if (currency && orderCurrency && orderCurrency !== currency) {
    throw new AppError('FUNNEL_CURRENCY_MISMATCH', `This funnel sells in ${currency}; this item is priced in ${orderCurrency}`, 422, [
      { field: 'items', message: `Priced in ${orderCurrency}, the funnel sells in ${currency}` },
    ]);
  }
}

module.exports = { currencyOf, publishProblems, assertOrderCurrency };
