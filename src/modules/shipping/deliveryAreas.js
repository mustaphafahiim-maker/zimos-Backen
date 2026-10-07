'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { governorateCode, GOVERNORATE_CODES } = require('./governorates');

/**
 * "Only deliver to these governorates" — a store that delivers with its own
 * couriers serves a few governorates and wants an order from anywhere else
 * refused at checkout, not priced at the default rate (or for free) and then
 * cancelled on the phone.
 *
 * settings.served_governorates holds governorate codes (governorates.js). A
 * store that never set it, or cleared it, serves everywhere — exactly as
 * before the setting existed. Checked by orderService.createOrder for the
 * shopper's own orders only (the same orders the minimum order binds).
 */
const KEY = 'served_governorates';

/** The governorates the store serves, or null when it serves everywhere. */
function servedGovernorates(settings) {
  const list = settings && settings[KEY];
  if (!Array.isArray(list)) return null;
  const known = list.filter((code) => GOVERNORATE_CODES.includes(code));
  return known.length > 0 ? known : null;
}

/** Throws 422 AREA_NOT_SERVED when the store limits its governorates and this address is outside them. */
async function assertAreaServed(workspaceId, shippingAddress, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  const served = servedGovernorates(workspace && workspace.settings);
  if (!served) return;
  const province = shippingAddress ? shippingAddress.province : null;
  const code = governorateCode(province);
  if (code && served.includes(code)) return;
  throw new AppError('AREA_NOT_SERVED', 'This store does not deliver to this area', 422, [
    {
      field: 'shippingAddress.province',
      message: 'This store does not deliver to this governorate',
      governorate: code,
      servedGovernorates: served,
    },
  ]);
}

module.exports = { SERVED_GOVERNORATES_KEY: KEY, servedGovernorates, assertAreaServed };
