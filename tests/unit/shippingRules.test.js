'use strict';

// The pure shipping rules: mixed carts, the free-shipping threshold, the
// precedence of the rules, governorate prices and the product fields.

const {
  RULES,
  DESTINATION_INDEPENDENT,
  productShipping,
  freeShippingProgress,
  ruleBeforeRates,
  governorateRate,
  fallbackRate,
  settingsPriceShipping,
  resolveProductShipping,
} = require('../../src/modules/shipping/shippingRules');
const { governorateCode, GOVERNORATES } = require('../../src/modules/shipping/governorates');

const standard = (units = 1) => ({ mode: 'standard', extraAmount: null, units });
const free = (units = 1) => ({ mode: 'free', extraAmount: null, units });
const extra = (amount, units = 1) => ({ mode: 'extra_fee', extraAmount: amount, units });

describe('productShipping', () => {
  it('is neutral for a cart of standard products (every store before product modes)', () => {
    expect(productShipping([standard(2), standard()])).toEqual({ allFree: false, extraFeesAmount: 0 });
  });

  it('treats an unknown or missing mode as standard', () => {
    expect(productShipping([{ units: 1 }, { mode: 'bogus', units: 3 }])).toEqual({ allFree: false, extraFeesAmount: 0 });
  });

  it('is all-free only when every line is free', () => {
    expect(productShipping([free(), free(3)]).allFree).toBe(true);
    expect(productShipping([free(), standard()]).allFree).toBe(false);
    expect(productShipping([free(), extra(500)]).allFree).toBe(false);
  });

  it('charges each extra fee per unit shipped and sums the lines', () => {
    // 2 × 15.00 + 3 × 5.00; the free and standard lines add nothing
    expect(productShipping([extra(1500, 2), extra('500', 3), free(), standard()])).toEqual({
      allFree: false,
      extraFeesAmount: 4500,
    });
  });

  it('has nothing to say about an empty or missing list', () => {
    expect(productShipping([])).toEqual({ allFree: false, extraFeesAmount: 0 });
    expect(productShipping(undefined)).toEqual({ allFree: false, extraFeesAmount: 0 });
  });
});

describe('freeShippingProgress', () => {
  it('is null without a threshold', () => {
    expect(freeShippingProgress(10000, undefined)).toBeNull();
    expect(freeShippingProgress(10000, null)).toBeNull();
  });

  it('counts down to the threshold and qualifies at it (>=), like the order', () => {
    expect(freeShippingProgress(7000, 50000)).toEqual({ thresholdAmount: 50000, remainingAmount: 43000, qualified: false });
    expect(freeShippingProgress(50000, 50000)).toEqual({ thresholdAmount: 50000, remainingAmount: 0, qualified: true });
    expect(freeShippingProgress(80000, '50000')).toEqual({ thresholdAmount: 50000, remainingAmount: 0, qualified: true });
  });

  it('treats a zero threshold as always free', () => {
    expect(freeShippingProgress(0, 0).qualified).toBe(true);
  });
});

describe('ruleBeforeRates', () => {
  const none = { allFree: false, extraFeesAmount: 0 };

  it('prices nothing without a country', () => {
    expect(ruleBeforeRates({ country: null, products: { allFree: true } })).toEqual({ rule: RULES.NO_DESTINATION, amount: 0 });
  });

  it('lets an offer override win over free products and the threshold', () => {
    const decided = ruleBeforeRates({
      country: 'EG',
      offerShippingOverride: { amount: 2500 },
      products: { allFree: true },
      progress: { qualified: true },
    });
    expect(decided).toEqual({ rule: RULES.OFFER_OVERRIDE, amount: 2500 });
  });

  it('ships an all-free cart free, before looking at the threshold', () => {
    expect(ruleBeforeRates({ country: 'EG', products: { allFree: true }, progress: { qualified: false } })).toEqual({
      rule: RULES.ALL_ITEMS_FREE,
      amount: 0,
    });
  });

  it('ships free at the threshold, extra fees included', () => {
    expect(
      ruleBeforeRates({ country: 'EG', products: { allFree: false, extraFeesAmount: 9000 }, progress: { qualified: true } })
    ).toEqual({ rule: RULES.FREE_THRESHOLD, amount: 0 });
  });

  it('leaves everything else to the destination rate', () => {
    expect(ruleBeforeRates({ country: 'EG', products: none, progress: { qualified: false } })).toBeNull();
    expect(ruleBeforeRates({ country: 'EG', products: none, progress: null })).toBeNull();
  });

  it('marks exactly the destination-free rules as not needing a governorate', () => {
    expect([...DESTINATION_INDEPENDENT].sort()).toEqual(
      [RULES.ALL_ITEMS_FREE, RULES.FREE_THRESHOLD, RULES.OFFER_OVERRIDE].sort()
    );
  });
});

describe('governorates', () => {
  it('reads every spelling an order or quote carries', () => {
    expect(governorateCode('القاهرة (Cairo)')).toBe('cairo');
    expect(governorateCode('Cairo')).toBe('cairo');
    expect(governorateCode('  cairo ')).toBe('cairo');
    expect(governorateCode('القاهرة')).toBe('cairo');
    expect(governorateCode('kafr-el-sheikh')).toBe('kafr-el-sheikh');
    expect(governorateCode('Kafr  El  Sheikh')).toBe('kafr-el-sheikh');
    expect(governorateCode('كفر الشيخ (Kafr El Sheikh)')).toBe('kafr-el-sheikh');
  });

  it('names none for anything else', () => {
    expect(governorateCode('Riyadh')).toBeNull();
    expect(governorateCode('')).toBeNull();
    expect(governorateCode(null)).toBeNull();
  });

  it('has the 27 governorates, each code once', () => {
    expect(GOVERNORATES).toHaveLength(27);
    expect(new Set(GOVERNORATES.map((g) => g.code)).size).toBe(27);
  });
});

describe('governorateRate / fallbackRate', () => {
  const settings = { shipping_governorate_rates: { cairo: 4500, aswan: 9000, giza: 0 } };

  it('prices a governorate the merchant set, from any spelling', () => {
    expect(governorateRate(settings, 'EG', 'القاهرة (Cairo)')).toEqual({ governorate: 'cairo', amount: 4500 });
    expect(governorateRate(settings, 'eg', 'Aswan')).toEqual({ governorate: 'aswan', amount: 9000 });
  });

  it('keeps a 0 price (free to that governorate) as a price', () => {
    expect(governorateRate(settings, 'EG', 'Giza')).toEqual({ governorate: 'giza', amount: 0 });
  });

  it('has nothing for an unset governorate, another country, or a store without overrides', () => {
    expect(governorateRate(settings, 'EG', 'Luxor')).toBeNull();
    expect(governorateRate(settings, 'SA', 'Cairo')).toBeNull();
    expect(governorateRate(settings, 'EG', null)).toBeNull();
    expect(governorateRate({}, 'EG', 'Cairo')).toBeNull();
  });

  it('falls back to the default rate, or free when there is none', () => {
    expect(fallbackRate({ default_shipping_rate_amount: 6000 })).toEqual({ rule: RULES.DEFAULT_RATE, amount: 6000 });
    expect(fallbackRate({ default_shipping_rate_amount: 0 })).toEqual({ rule: RULES.DEFAULT_RATE, amount: 0 });
    expect(fallbackRate({})).toEqual({ rule: RULES.NO_RATE, amount: 0 });
  });
});

describe('settingsPriceShipping', () => {
  it('is false for a store that never touched shipping', () => {
    expect(settingsPriceShipping({})).toBe(false);
    expect(settingsPriceShipping({ tax_enabled: true, shipping_governorate_rates: {} })).toBe(false);
    expect(settingsPriceShipping(null)).toBe(false);
  });

  it('is true once any price is set', () => {
    expect(settingsPriceShipping({ default_shipping_rate_amount: 0 })).toBe(true);
    expect(settingsPriceShipping({ free_shipping_threshold_amount: 50000 })).toBe(true);
    expect(settingsPriceShipping({ shipping_governorate_rates: { cairo: 4500 } })).toBe(true);
    expect(settingsPriceShipping({ shipping_pricing_mode: 'weight_tiers' })).toBe(true);
  });
});

describe('resolveProductShipping', () => {
  const current = { shippingMode: 'standard', shippingExtraAmount: null };

  it('leaves the fields alone when neither is sent', () => {
    expect(resolveProductShipping(current, {})).toEqual({ value: null });
  });

  it('sets an extra fee with its amount', () => {
    expect(resolveProductShipping(current, { shippingMode: 'extra_fee', shippingExtraAmount: 2500 })).toEqual({
      value: { shippingMode: 'extra_fee', shippingExtraAmount: 2500 },
    });
  });

  it('needs an amount for an extra fee, from the request or the product', () => {
    expect(resolveProductShipping(current, { shippingMode: 'extra_fee' }).error.field).toBe('shippingExtraAmount');
    expect(resolveProductShipping(null, { shippingMode: 'extra_fee' }).error.field).toBe('shippingExtraAmount');
    const withFee = { shippingMode: 'extra_fee', shippingExtraAmount: '2500' };
    expect(resolveProductShipping(withFee, { shippingExtraAmount: 4000 })).toEqual({
      value: { shippingMode: 'extra_fee', shippingExtraAmount: 4000 },
    });
  });

  it('clears the amount when the mode moves away from extra fee', () => {
    const withFee = { shippingMode: 'extra_fee', shippingExtraAmount: '2500' };
    expect(resolveProductShipping(withFee, { shippingMode: 'free' })).toEqual({
      value: { shippingMode: 'free', shippingExtraAmount: null },
    });
  });

  it('refuses an amount without the extra-fee mode', () => {
    expect(resolveProductShipping(current, { shippingExtraAmount: 2500 }).error.field).toBe('shippingExtraAmount');
    expect(resolveProductShipping(current, { shippingMode: 'free', shippingExtraAmount: 2500 }).error.field).toBe(
      'shippingExtraAmount'
    );
  });
});
