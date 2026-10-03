'use strict';

/**
 * Currencies (SPEC §11.5): the exchange rates table, filled daily by the rates
 * adapter, and — on each order — the rate from its own currency to the
 * store's base currency at the moment it was placed, with the total in base
 * currency, so analytics add up orders taken in different currencies.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('fx_rates', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      base: { type: DataTypes.STRING(3), allowNull: false },
      quote: { type: DataTypes.STRING(3), allowNull: false },
      // 1 unit of `base` = `rate` units of `quote`.
      rate: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
      source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'sandbox' },
      fetched_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('fx_rates', ['base', 'quote'], { unique: true, name: 'fx_rates_base_quote_uq' });
    await queryInterface.addColumn('orders', 'fx_rate_to_base', { type: DataTypes.DECIMAL(18, 8), allowNull: true });
    await queryInterface.addColumn('orders', 'total_amount_base', { type: DataTypes.BIGINT, allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'total_amount_base');
    await queryInterface.removeColumn('orders', 'fx_rate_to_base');
    await queryInterface.dropTable('fx_rates');
  },
};
