'use strict';

const db = require('../../db/models');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const carriers = require('./carriers');
const { GOVERNORATES } = require('./governorates');

/**
 * The store's shipping prices and default courier, as the dashboard's
 * Shipping settings section edits them. All four live in workspaces.settings
 * (never themeSettings), next to the other shipping knobs:
 *
 *   default_shipping_rate_amount    the price when nothing more specific matches
 *   free_shipping_threshold_amount  subtotal at/above which shipping is free
 *   shipping_governorate_rates      { <governorate code>: amount } — overrides
 *                                   of the default, rate pricing only
 *   default_carrier_code            'manual' or a courier code: preselected
 *                                   when booking; never changes a price
 *   served_governorates             [<governorate code>] — the only ones the
 *                                   store delivers to (deliveryAreas.js);
 *                                   absent or empty = everywhere
 *   store_pickup                    { enabled, address, phone, note } —
 *                                   pickup from the store (storePickup.js)
 *   delivery_zones_enabled          true = checkout prices by the store's
 *                                   delivery zones (deliveryZones.js)
 *   store_hours                     opening hours + "accepting orders"
 *                                   switch (storeHours.js)
 *   delivery_eta_minutes            the usual delivery time, minutes
 *
 * The first two were already writable through PATCH /workspaces/:id and
 * still are (same keys, same meaning). A key the store never set is absent,
 * and an absent key prices exactly as before this section existed.
 */

const KEYS = Object.freeze({
  defaultRateAmount: 'default_shipping_rate_amount',
  freeShippingThresholdAmount: 'free_shipping_threshold_amount',
  governorateRates: 'shipping_governorate_rates',
  defaultCarrierCode: 'default_carrier_code',
  servedGovernorates: 'served_governorates',
  storePickup: 'store_pickup',
  deliveryZonesEnabled: 'delivery_zones_enabled',
  storeHours: 'store_hours',
  deliveryEtaMinutes: 'delivery_eta_minutes',
});

const MANUAL = carriers.MANUAL;

function view(settings) {
  const s = settings || {};
  const amount = (value) => (value === undefined || value === null ? null : Number(value));
  const rates = s[KEYS.governorateRates] && typeof s[KEYS.governorateRates] === 'object' ? s[KEYS.governorateRates] : {};
  return {
    pricingMode: s.shipping_pricing_mode === 'weight_tiers' ? 'weight_tiers' : 'rates',
    defaultRateAmount: amount(s[KEYS.defaultRateAmount]),
    freeShippingThresholdAmount: amount(s[KEYS.freeShippingThresholdAmount]),
    governorateRates: Object.fromEntries(Object.entries(rates).map(([code, value]) => [code, Number(value)])),
    defaultCarrierCode: s[KEYS.defaultCarrierCode] || null,
    servedGovernorates: Array.isArray(s[KEYS.servedGovernorates]) ? [...s[KEYS.servedGovernorates]] : [],
    storePickup: require('./storePickup').pickupSettings(s),
    deliveryZonesEnabled: s[KEYS.deliveryZonesEnabled] === true,
    storeHours: require('./storeHours').hoursSettings(s),
    deliveryEtaMinutes: require('./storeHours').etaMinutes(s),
  };
}

/** The couriers this store may pick as its default, with whether each is connected. */
async function carrierOptions(workspaceId) {
  const adapters = await carriers.adaptersFor(workspaceId);
  const accounts = await db.CarrierAccount.findAll({ where: { workspaceId }, attributes: ['carrierCode', 'status'] });
  const connected = new Set(accounts.filter((a) => a.status === 'active').map((a) => a.carrierCode));
  return adapters.map((adapter) => ({ code: adapter.code, name: adapter.name, connected: connected.has(adapter.code) }));
}

/** GET /shipping/settings */
async function getSettings(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return {
    settings: view(workspace.settings),
    governorates: GOVERNORATES,
    carriers: await carrierOptions(workspaceId),
  };
}

/**
 * PATCH /shipping/settings — every field optional; one that is sent replaces
 * the stored value, `null` clears it. `governorateRates` is the whole map (an
 * empty object clears every override). Validated by shippingValidation; the
 * courier is checked here against the couriers this store may use.
 */
async function updateSettings(workspaceId, body, req) {
  if (body.defaultCarrierCode) {
    const known = body.defaultCarrierCode === MANUAL || (await carriers.adapterFor(body.defaultCarrierCode, workspaceId));
    if (!known) {
      throw new ValidationError(
        [{ field: 'defaultCarrierCode', message: `"${body.defaultCarrierCode}" is not a courier this store can use` }],
        'Invalid body'
      );
    }
  }

  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = view(workspace.settings);

    const next = { ...(workspace.settings || {}) };
    for (const [field, key] of Object.entries(KEYS)) {
      if (!(field in body)) continue;
      const value = body[field];
      const empty =
        value === null ||
        (field === 'governorateRates' && Object.keys(value).length === 0) ||
        (field === 'servedGovernorates' && value.length === 0) ||
        (field === 'deliveryZonesEnabled' && value === false);
      if (empty) delete next[key];
      else next[key] = value;
    }
    workspace.settings = next;
    workspace.changed('settings', true);
    await workspace.save({ transaction });

    const after = view(next);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipping.settings_update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before,
      after,
      req,
      transaction,
    });
    return { settings: after };
  });
}

module.exports = { SHIPPING_SETTING_KEYS: KEYS, getSettings, updateSettings, view };
