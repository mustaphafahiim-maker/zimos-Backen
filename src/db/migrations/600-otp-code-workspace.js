'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The store a checkout code was sent for (risk/checkoutOtp). The storefront's
 * Resend button (POST /store/:workspaceId/checkout/otp/resend) only sends
 * again to a phone this same store already challenged at checkout, so it can
 * no longer send a first code to any number through any store. Null for the
 * other purposes (sign-in, account codes), which are not tied to a store.
 *
 * Additive and run-twice safe: a nullable column, skipped when present.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('otp_codes', 'workspace_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
    });
  },
  down: async (queryInterface) => {
    await guarded(queryInterface).removeColumn('otp_codes', 'workspace_id');
  },
};
