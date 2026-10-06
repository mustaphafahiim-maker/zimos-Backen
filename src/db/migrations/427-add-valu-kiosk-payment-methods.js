'use strict';

/**
 * Two more ways to pay online (SPEC §11.2 "Paymob (card, wallets, valU,
 * Kiosk)"): `valu` (valU installments) and `kiosk` (a reference paid in cash
 * at an Aman / Masary outlet), on orders.payment_method. Both go through the
 * store's gateway like a card (payments/methodNames.js).
 *
 * Down leaves the values: Postgres cannot drop an enum value in place, and an
 * unused value is harmless.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query("ALTER TYPE enum_orders_payment_method ADD VALUE IF NOT EXISTS 'valu'");
    await queryInterface.sequelize.query("ALTER TYPE enum_orders_payment_method ADD VALUE IF NOT EXISTS 'kiosk'");
  },
  down: async () => {},
};
