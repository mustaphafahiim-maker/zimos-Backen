'use strict';

/**
 * PayPal as a way to pay (spec-gaps item 183, payments/gateways/paypal.js):
 * `paypal` on orders.payment_method.
 *
 * Down leaves the value: Postgres cannot drop an enum value in place, and an
 * unused value is harmless.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query("ALTER TYPE enum_orders_payment_method ADD VALUE IF NOT EXISTS 'paypal'");
  },
  down: async () => {},
};
