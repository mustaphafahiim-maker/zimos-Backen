'use strict';

const db = require('../../db/models');
const { applyBasisPoints } = require('../../core/utils/money');

/**
 * Computes tax for a set of order lines using the workspace's configured
 * TaxRate rows: a product-specific rate takes precedence over the
 * workspace-wide default for that country/region. Prices-include-tax mode
 * is supported by treating the rate as already baked into the line price
 * (returning 0 additional tax, since the amount was already collected) —
 * callers that need the *implied* tax portion for reporting can derive it
 * from rateBasisPoints separately.
 *
 * Tax is opt-in: unless workspace.settings.tax_enabled is true this returns
 * zero tax regardless of how many TaxRate rows exist.
 *
 * `transaction`: the caller's, when it prices inside one (order creation and
 * edits). A read outside it would wait for a second pooled connection while
 * the transaction holds the first, and a burst of checkouts starves the pool.
 */
async function calculateTax(workspaceId, { country, region, lines, shippingAmount, transaction }) {
  const workspace = await db.Workspace.findByPk(workspaceId, { transaction });
  const taxEnabled = Boolean(workspace && workspace.settings && workspace.settings.tax_enabled);
  if (!taxEnabled) return { taxAmount: 0, pricesIncludeTax: false };

  const rates = await db.TaxRate.findAll({ where: { workspaceId }, transaction });
  if (rates.length === 0) return { taxAmount: 0, pricesIncludeTax: false };

  const matchRate = (productId) => {
    const productSpecific = rates.find((r) => r.productId === productId && matchesRegion(r, country, region));
    if (productSpecific) return productSpecific;
    return rates.find((r) => !r.productId && matchesRegion(r, country, region));
  };

  let taxAmount = 0;
  let pricesIncludeTax = false;

  for (const line of lines) {
    const rate = matchRate(line.productId);
    if (!rate) continue;
    if (rate.pricesIncludeTax) {
      pricesIncludeTax = true;
      continue; // Tax already included in lineTotal; not added on top.
    }
    taxAmount += applyBasisPoints(line.lineTotal, rate.rateBasisPoints);
    if (rate.appliesToShipping && shippingAmount) {
      taxAmount += applyBasisPoints(shippingAmount, rate.rateBasisPoints);
    }
  }

  return { taxAmount, pricesIncludeTax };
}

function matchesRegion(rate, country, region) {
  if (rate.country && rate.country !== country) return false;
  if (rate.region && rate.region !== region) return false;
  return true;
}

module.exports = { calculateTax };
