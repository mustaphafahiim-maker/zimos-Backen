'use strict';

/**
 * billing_invoices.subscription_before_payment (JSONB): the subscription's
 * status and period just before this charge's payment changed them, written
 * when the charge is paid and cleared when a manual payment is reversed.
 *
 * Reversing a payment moves the subscription to past_due only when that
 * payment is what made it active — which needs to know what it was before.
 * Charges paid before this migration have no snapshot.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('billing_invoices', 'subscription_before_payment', {
      type: Sequelize.DataTypes.JSONB,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('billing_invoices', 'subscription_before_payment');
  },
};
