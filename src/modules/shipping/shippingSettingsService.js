'use strict';

const db = require('../../db/models');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const carriers = require('./carriers');
const places = require('./shippingPlaces');

/**
 * The store's shipping prices and default courier, as the dashboard's
 * Shipping settings section edits them. All four live in workspaces.settings
 * (never themeSettings), next to the other shipping knobs:
 *
 *   default_shipping_rate_amount    the price when nothing more specific matches
 *   free_shipping_threshold_amount  subtotal at/above which shipping is free
 *   shipping_governorate_rates      { <place code>: amount } — overrides of
 *                                   the default, rate pricing only; any place
 *                                   of the platform's list (shippingPlaces.js)
 *   shipping_hidden_places          [<place code>] — not delivered to
 *   default_carrier_code            'manual' or a courier code: preselected
 *                                   when booking; never changes a price
 *
 * The first two were already writable through PATCH /workspaces/:id and
 * still are (same keys, same meaning). A key the store never set is absent,
 * and an absent key prices exactly as before this section existed.
 */

const KEYS = Object.freeze({
  defaultRateAmount: 'default_shipping_rate_amount',
  freeShippingThresholdAmount: 'free_shipping_threshold_amount',
  governorateRates: 'shipping_governorate_rates',
  hiddenPlaces: places.HIDDEN_KEY,
  defaultCarrierCode: 'default_carrier_code',
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
    hiddenPlaces: places.hiddenOf(s),
    defaultCarrierCode: s[KEYS.defaultCarrierCode] || null,
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
  // The store's country's places (Egypt with North Coast, Saudi regions); a country the list lacks has none.
  const country = require('../../core/utils/storeCountry').countryOf(workspace);
  return {
    settings: view(workspace.settings),
    country,
    governorates: await places.placesFor(country),
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

  if (body.governorateRates) await places.assertKnown(Object.keys(body.governorateRates), 'governorateRates');
  if (body.hiddenPlaces) await places.assertKnown(body.hiddenPlaces, 'hiddenPlaces');

  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = view(workspace.settings);

    const next = { ...(workspace.settings || {}) };
    for (const [field, key] of Object.entries(KEYS)) {
      if (!(field in body)) continue;
      const value = body[field];
      const empty = value === null || (field === 'governorateRates' && Object.keys(value).length === 0) || (field === 'hiddenPlaces' && value.length === 0);
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
