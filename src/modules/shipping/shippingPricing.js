'use strict';

const db = require('../../db/models');
const { summarizeWeight, describeTiers, resolveTier } = require('./shippingWeight');
const rules = require('./shippingRules');

/**
 * Prices the shipping line shown at checkout and works out the order's
 * weight and weight tier. Real carrier integration (waybill creation,
 * tracking) lives in modules/shipping/carriers/*; the carrier a merchant
 * books with never changes this amount.
 *
 * Weight: `weightLines` (see shippingWeight.summarizeWeight) are weighed with
 * the store's default_item_weight_grams standing in for a missing variant
 * weight. Callers that only have a number may pass `totalWeightGrams`
 * instead. The tier is resolved whenever the store has tiers, in either
 * pricing mode, because courier bookings use it too.
 *
 * Amount — the full precedence is documented in shippingRules.js:
 *   1. No destination country → 0 (nothing to price against).
 *   2. An offer-level shipping override always wins.
 *   3. Every line's product is set to free shipping → 0.
 *   4. A configured free-shipping threshold the subtotal reaches → 0.
 *   5. The destination's rate (the "base"), by settings.shipping_pricing_mode:
 *        'rates' (default)  the merchant's price for the destination
 *                           governorate (settings.shipping_governorate_rates),
 *                           else the cheapest active rate in the matching zone,
 *                           exactly as before tiers existed. Weight-based
 *                           rates see known weights only (a missing weight
 *                           counts as 0), never the default weight.
 *        'weight_tiers'     that zone's price for the order's tier. Other
 *                           matching zones are not consulted.
 *      The zone lookup (findApplicableZone) is shared by both modes, so a
 *      destination always lands in the same zone. When nothing prices it:
 *      the workspace's default shipping rate, or 0 when none is set (free
 *      rather than blocking checkout).
 *      Plus the extra fee of every "extra fee" product, per unit shipped.
 *
 * A store that sets none of the new knobs (governorate rates, product
 * modes) prices exactly as it did before them.
 *
 * `productLines` — [{ mode, extraAmount, units }] per order line, see
 * shippingRules.productShipping. Optional; without it no product rule applies.
 *
 * Live carrier prices: when they come, they are one more source for the base
 * in resolveBase below (before the zone lookup, keyed on the destination and
 * the weight/tier already worked out here) — nothing else here changes, and
 * the order still stores the amount, never the carrier.
 *
 * @returns {Promise<{ amount: number, weightGrams: number|null, tier: object|null,
 *   weightEstimated: boolean, pricingMode: string, lineWeights: Array<number|null>,
 *   rule: string, baseAmount: number, extraFeesAmount: number, governorate: string|null,
 *   freeShipping: object|null }>}
 */
async function calculateShippingAmount(
  workspaceId,
  {
    country,
    region,
    subtotal,
    totalWeightGrams,
    totalQuantity,
    offerShippingOverride,
    weightLines,
    productLines: rawProductLines,
    // An order in a funnel: the funnel's shipping group prices every line (funnels/funnelShipping.js).
    funnelId = null,
    // The whole address (province, city, area, placeId): the store's own place prices read it (places/placePricing.js).
    address = null,
    transaction,
  }
) {
  const workspace = await db.Workspace.findByPk(workspaceId, { transaction });
  const settings = (workspace && workspace.settings) || {};
  // An order in a funnel: its group, its threshold, and its currency's rules (funnels/funnelShipping.js).
  const funnelPricing = await require('../funnels/funnelShipping').pricingFor(workspaceId, funnelId, workspace, rawProductLines, transaction);
  const { productLines } = funnelPricing;
  const pricingMode = settings.shipping_pricing_mode === 'weight_tiers' ? 'weight_tiers' : 'rates';

  const weight = weightLines
    ? summarizeWeight(weightLines, settings.default_item_weight_grams ?? null)
    : {
        grams: totalWeightGrams ?? null,
        knownGrams: Number(totalWeightGrams) || 0,
        estimated: false,
        perLine: [],
      };
  const tiers = await loadTiers(workspaceId, transaction);
  const tier = resolveTier(tiers, weight.grams);

  const products = rules.productShipping(productLines);
  const freeShipping = rules.freeShippingProgress(subtotal, funnelPricing.thresholdAmount);

  const result = ({ rule, amount, baseAmount = amount, extraFeesAmount = 0, governorate = null }) => ({
    amount,
    weightGrams: weight.grams,
    tier,
    weightEstimated: weight.estimated,
    pricingMode,
    lineWeights: weight.perLine,
    rule,
    baseAmount,
    extraFeesAmount,
    governorate,
    freeShipping,
    // A funnel selling in another currency than the store's: that currency (its group priced it).
    ownCurrency: funnelPricing.ownCurrency ? funnelPricing.ownCurrency.currency : null,
  });

  const decided = rules.ruleBeforeRates({ country, offerShippingOverride, products, progress: freeShipping });
  if (decided) return result(decided);
  // The destination as a place of the platform's list (shippingPlaces.js): Egypt's governorates and North Coast, Saudi regions.
  const place = await require('./shippingPlaces').placeCode(country, region, transaction);

  // A funnel selling in another currency than the store's: its own group is the only price.
  if (funnelPricing.ownCurrency) {
    const profiles = require('./shippingProfiles');
    const price = funnelPricing.ownCurrency.profile ? profiles.priceOf(funnelPricing.ownCurrency.profile, place) : null;
    const own = price === null ? { rule: rules.RULES.NO_RATE, amount: 0 } : { rule: profiles.RULE, amount: price };
    return result({ ...own, amount: own.amount + products.extraFeesAmount, baseAmount: own.amount, extraFeesAmount: products.extraFeesAmount });
  }

  const storeBase = await resolveBase(workspaceId, settings, {
    pricingMode,
    country,
    region,
    place,
    address,
    subtotal,
    tier,
    knownGrams: weight.knownGrams,
    totalQuantity,
    transaction,
  });
  // Products in a shipping group carry their own price (shippingProfiles.js): the dearest applies.
  const base = await require('./shippingProfiles').applyProfiles(workspaceId, { base: storeBase, productLines, place, transaction });
  return result({
    ...base,
    amount: Number(base.amount) + products.extraFeesAmount,
    baseAmount: base.amount,
    extraFeesAmount: products.extraFeesAmount,
  });
}

/**
 * The destination's price: { rule, amount, governorate? }. The sources are
 * tried in order; a live carrier quote would be another source here.
 */
async function resolveBase(
  workspaceId,
  settings,
  { pricingMode, country, region, place, address, subtotal, tier, knownGrams, totalQuantity, transaction }
) {
  const fallback = rules.fallbackRate(settings);

  if (pricingMode === 'rates') {
    // A price on the store's own city or area wins over its governorate price (places/placePricing.js).
    const byPlace = await require('../places/placePricing').priceFor(workspaceId, address || (country ? { country, province: region } : null), transaction);
    if (byPlace) return { rule: byPlace.rule, amount: byPlace.amount, governorate: place || null };
    const byGovernorate = require('./shippingPlaces').rateFor(settings, place);
    if (byGovernorate) return { rule: rules.RULES.GOVERNORATE_RATE, ...byGovernorate };
  }

  const applicableZone = await findApplicableZone(workspaceId, country, region, transaction);
  if (!applicableZone) return fallback;

  if (pricingMode === 'weight_tiers') {
    if (!tier) return fallback;
    const price = await db.ShippingZoneTierPrice.findOne({
      where: { zoneId: applicableZone.id, tierId: tier.id },
      transaction,
    });
    return price ? { rule: rules.RULES.ZONE_TIER_PRICE, amount: Number(price.amount) } : fallback;
  }

  if (applicableZone.rates.length === 0) return fallback;
  const candidates = applicableZone.rates.map((rate) =>
    computeRateAmount(rate, { subtotal, totalWeightGrams: knownGrams, totalQuantity })
  );
  return { rule: rules.RULES.ZONE_RATE, amount: Math.min(...candidates) };
}

/**
 * The zone a destination is priced in: the first active zone for the
 * country that matchesZone accepts, carrying its active rates. This is the
 * lookup rate pricing has always done, kept as one query so tier pricing
 * picks exactly the zone rate pricing would.
 */
async function findApplicableZone(workspaceId, country, region, transaction) {
  const zones = await db.ShippingZone.findAll({
    where: {
      workspaceId,
      isActive: true,
      countries: { [db.Sequelize.Op.contains]: [country] },
    },
    // LEFT JOIN filtered to active rates — a zone with no active rate still
    // comes back (with rates: []) and prices at the fallback.
    include: [{ model: db.ShippingRate, as: 'rates', where: { isActive: true }, required: false }],
    transaction,
  });
  return zones.find((z) => matchesZone(z, region)) || null;
}

/** The workspace's tiers, described and sorted (see shippingWeight). */
async function loadTiers(workspaceId, transaction) {
  const rows = await db.ShippingWeightTier.findAll({ where: { workspaceId }, transaction });
  return describeTiers(rows);
}

/**
 * The destination country is already guaranteed to be in `countries` by the
 * query. On top of that a zone matches when:
 *   - the destination region is not in `excludedRegions`, AND
 *   - if the zone lists positive `regions`, the destination region is one of
 *     them. An empty `regions` list keeps the zone country-only (plus the
 *     exclusion list) — the original behaviour, so zones that only use
 *     `excludedRegions` are unaffected.
 */
function matchesZone(zone, region) {
  if (region && zone.excludedRegions.includes(region)) return false;
  const positiveRegions = Array.isArray(zone.regions) ? zone.regions : [];
  if (positiveRegions.length > 0) {
    return Boolean(region) && positiveRegions.includes(region);
  }
  return true;
}

function computeRateAmount(rate, { subtotal, totalWeightGrams, totalQuantity }) {
  switch (rate.rateType) {
    case 'free':
      return 0;
    case 'flat':
      return rate.config.amount || 0;
    case 'weight_based': {
      const tier = (rate.config.tiers || []).find((t) => totalWeightGrams <= t.upToGrams);
      return tier ? tier.amount : rate.config.overflowAmount || 0;
    }
    case 'quantity_based': {
      const tier = (rate.config.tiers || []).find((t) => totalQuantity <= t.upToQuantity);
      return tier ? tier.amount : rate.config.overflowAmount || 0;
    }
    case 'order_value_based': {
      const sorted = [...(rate.config.tiers || [])].sort((a, b) => b.minSubtotal - a.minSubtotal);
      const tier = sorted.find((t) => subtotal >= t.minSubtotal);
      return tier ? tier.amount : 0;
    }
    default:
      return 0;
  }
}

module.exports = { calculateShippingAmount, findApplicableZone, loadTiers, matchesZone, computeRateAmount };
