'use strict';

/**
 * A fee or a discount tied to the payment method (SPEC §11.4) — "+10 for cash
 * on delivery", "5% off when you pay online" — kept as its own line of the
 * order: a signed amount (fee positive, discount negative) and the label the
 * shopper saw. It is part of total_amount.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('orders', 'payment_adjustment_amount', { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('orders', 'payment_adjustment_label', { type: DataTypes.STRING(100), allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'payment_adjustment_label');
    await queryInterface.removeColumn('orders', 'payment_adjustment_amount');
  },
};
