'use strict';

/**
 * orders.checkout_fields: the shopper's answers to the purchase-form fields
 * that have no column of their own (the Saudi national address and the
 * merchant's custom fields), as [{ key, label: { ar, en }, value }] — each
 * with the label it was asked under (modules/checkout/checkoutForm.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('orders', 'checkout_fields', {
      type: Sequelize.DataTypes.JSONB,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'checkout_fields');
  },
};
