'use strict';

const Joi = require('joi');
const { GOVERNORATE_CODES } = require('./governorates');

const uuid = Joi.string().uuid();
// A time of day, 00:00-23:59 (opening hours).
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const country = Joi.string().length(2).uppercase();
const rateType = Joi.string().valid('flat', 'weight_based', 'quantity_based', 'order_value_based', 'free');

// Bare field definitions shared by the create and update schemas. The create
// bodies below re-apply `.required()` / `.default(...)`; the update bodies use
// these as-is so a PATCH only writes the fields it actually sends — an
// unspecified array or flag is never reset to a default.
const zoneFields = {
  name: Joi.string().min(1).max(150),
  countries: Joi.array().items(country),
  regions: Joi.array().items(Joi.string().max(100)),
  excludedRegions: Joi.array().items(Joi.string().max(100)),
  isActive: Joi.boolean(),
};

const rateFields = {
  name: Joi.string().min(1).max(150),
  rateType,
  config: Joi.object(),
  carrierCode: Joi.string().max(100).allow(null, ''),
  isActive: Joi.boolean(),
  // Nullable so a PATCH can clear a previously set estimate.
  estimatedDeliveryMinDays: Joi.number().integer().min(0).max(3650).allow(null),
  estimatedDeliveryMaxDays: Joi.number().integer().min(0).max(3650).allow(null),
};

const createZoneBody = Joi.object({
  ...zoneFields,
  name: zoneFields.name.required(),
  countries: zoneFields.countries.default([]),
  regions: zoneFields.regions.default([]),
  excludedRegions: zoneFields.excludedRegions.default([]),
});

const updateZoneBody = Joi.object(zoneFields).min(1);

const createRateBody = Joi.object({
  ...rateFields,
  name: rateFields.name.required(),
  rateType: rateFields.rateType.required(),
  config: rateFields.config.default({}),
});

const updateRateBody = Joi.object(rateFields).min(1);

// Weight tiers: inclusive upper bounds in grams, in order; null = open ended
// (last tier only — the ordering rules are checked by shippingWeight).
const tierBody = Joi.object({
  tiers: Joi.array()
    .items(
      Joi.object({
        id: uuid.optional(),
        upToGrams: Joi.number().integer().min(1).max(1000000).allow(null).required(),
      })
    )
    .min(1)
    .max(20)
    .required(),
});

const tierPricesBody = Joi.object({
  prices: Joi.array()
    .items(Joi.object({ tierId: uuid.required(), amount: Joi.number().integer().min(0).max(100000000).required() }))
    .max(20)
    .required(),
});

// Integer minor units, capped like the tier prices above.
const amount = Joi.number().integer().min(0).max(100000000);

// The store's prices and default courier — see shippingSettingsService.
const settingsBody = Joi.object({
  defaultRateAmount: amount.allow(null),
  freeShippingThresholdAmount: amount.allow(null),
  // The whole map; a governorate left out uses the default rate. An unknown
  // code is refused, not stripped: a typo must not silently lose a price.
  governorateRates: Joi.object()
    .pattern(Joi.string().max(40), amount.required())
    .custom((value, helpers) => {
      const unknown = Object.keys(value).find((code) => !GOVERNORATE_CODES.includes(code));
      return unknown ? helpers.message(`"${unknown}" is not a governorate code`) : value;
    }),
  // 'manual' or a courier code, checked against the store's couriers by the service.
  defaultCarrierCode: Joi.string().max(50).allow(null),
  // The only governorates the store delivers to; [] or null = everywhere (deliveryAreas.js).
  servedGovernorates: Joi.array()
    .items(Joi.string().valid(...GOVERNORATE_CODES))
    .unique()
    .max(GOVERNORATE_CODES.length)
    .allow(null),
  // Pickup from the store (storePickup.js); null clears it (= off).
  storePickup: Joi.object({
    enabled: Joi.boolean().required(),
    address: Joi.string().trim().max(300).allow(''),
    phone: Joi.string().trim().max(32).allow(''),
    note: Joi.string().trim().max(300).allow(''),
  }).allow(null),
  // Checkout prices by the store's delivery zones (deliveryZones.js); false/null = by governorate.
  deliveryZonesEnabled: Joi.boolean().allow(null),
  // Opening hours in Africa/Cairo (storeHours.js); null clears them (= always open).
  storeHours: Joi.object({
    enabled: Joi.boolean().required(),
    override: Joi.string().valid('auto', 'open', 'closed').default('auto'),
    days: Joi.array()
      .items(
        Joi.object({
          closed: Joi.boolean().required(),
          // One period, as before; optional when `periods` is sent (they mirror its first).
          open: Joi.string().pattern(HHMM).when('periods', { is: Joi.array().min(1), then: Joi.optional(), otherwise: Joi.required() }),
          close: Joi.string().pattern(HHMM).when('periods', { is: Joi.array().min(1), then: Joi.optional(), otherwise: Joi.required() }),
          // Up to 3 periods a day (morning and evening), none overlapping (storeHours.periodsProblem).
          periods: Joi.array()
            .items(Joi.object({ open: Joi.string().pattern(HHMM).required(), close: Joi.string().pattern(HHMM).required() }))
            .min(1)
            .max(3),
        }).custom((day, helpers) => {
          if (!day.periods) return day;
          const problem = require('./storeHours').periodsProblem(day.periods);
          if (problem) return helpers.message(problem);
          // The first period stays in open/close, for anything that reads one period a day.
          return { ...day, open: day.periods[0].open, close: day.periods[0].close };
        })
      )
      .length(7)
      .required(),
    message: Joi.string().trim().max(300).allow(''),
  }).allow(null),
  // The usual delivery time shown to customers, minutes; null clears it.
  deliveryEtaMinutes: Joi.number().integer().min(1).max(1440).allow(null),
}).min(1);

const pricingModeBody = Joi.object({
  mode: Joi.string().valid('rates', 'weight_tiers').required(),
  defaultItemWeightGrams: Joi.number().integer().min(1).max(1000000).optional(),
  prefill: Joi.boolean().default(true),
  dryRun: Joi.boolean().default(false),
});

module.exports = {
  listZones: { params: Joi.object({ workspaceId: uuid.required() }) },
  zoneParams: { params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }) },
  rateParams: { params: Joi.object({ workspaceId: uuid.required(), rateId: uuid.required() }) },

  createZone: { params: Joi.object({ workspaceId: uuid.required() }), body: createZoneBody },
  updateZone: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: updateZoneBody,
  },

  createRate: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: createRateBody,
  },
  weightTiers: { params: Joi.object({ workspaceId: uuid.required() }) },
  replaceWeightTiers: { params: Joi.object({ workspaceId: uuid.required() }), body: tierBody },
  replaceTierPrices: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: tierPricesBody,
  },
  pricingMode: { params: Joi.object({ workspaceId: uuid.required() }), body: pricingModeBody },
  settings: { params: Joi.object({ workspaceId: uuid.required() }) },
  updateSettings: { params: Joi.object({ workspaceId: uuid.required() }), body: settingsBody },

  updateRate: {
    params: Joi.object({ workspaceId: uuid.required(), rateId: uuid.required() }),
    body: updateRateBody,
  },
};
