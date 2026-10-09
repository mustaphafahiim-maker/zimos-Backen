'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Who asked for a checkout code (risk/checkoutOtp): the client address (an
 * IPv6 /56) a checkout, COD switch or Resend code was sent for, so a per-IP
 * send budget can hold across every store and every API instance. Null for
 * the other purposes.
 *
 * Additive and run-twice safe. The index is built CONCURRENTLY by the guard
 * (no transaction, a table this migration did not create).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('otp_codes', 'request_ip', { type: Sequelize.STRING(64), allowNull: true });
    await qi.addIndex('otp_codes', ['request_ip', 'created_at'], { name: 'otp_codes_request_ip_created_at' });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeIndex('otp_codes', 'otp_codes_request_ip_created_at');
    await qi.removeColumn('otp_codes', 'request_ip');
  },
};
