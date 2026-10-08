'use strict';

/**
 * Who asked for a checkout code (item 348, review). The storefront checkout,
 * the COD switch and the Resend button each send a paid WhatsApp/SMS code; the
 * per-IP budget in risk/checkoutOtp counts the codes one address (an IPv6 /56)
 * asked for across every store, so one client cannot send codes to as many
 * numbers as it likes. Null for the other purposes.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('otp_codes', 'request_ip', { type: Sequelize.STRING(64), allowNull: true });
    await queryInterface.addIndex('otp_codes', ['request_ip', 'created_at'], { name: 'otp_codes_request_ip_created_at' });
  },
  down: async (queryInterface) => {
    await queryInterface.removeIndex('otp_codes', 'otp_codes_request_ip_created_at');
    await queryInterface.removeColumn('otp_codes', 'request_ip');
  },
};
