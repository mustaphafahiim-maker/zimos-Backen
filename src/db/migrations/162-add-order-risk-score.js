'use strict';

/**
 * The risk score of an order (modules/risk/riskService): points, the level
 * they add up to, the reasons, and how usable the typed data looks. All null
 * on orders created before scoring existed and on staff-created orders.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('orders', 'risk_score', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('orders', 'risk_level', { type: DataTypes.STRING(10), allowNull: true });
    await queryInterface.addColumn('orders', 'risk_reasons', { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addColumn('orders', 'data_quality', { type: DataTypes.STRING(10), allowNull: true });
    await queryInterface.sequelize.query(
      `CREATE INDEX orders_ws_risk_level_idx ON orders (workspace_id, risk_level, created_at)
        WHERE risk_level IS NOT NULL`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS orders_ws_risk_level_idx');
    await queryInterface.removeColumn('orders', 'data_quality');
    await queryInterface.removeColumn('orders', 'risk_reasons');
    await queryInterface.removeColumn('orders', 'risk_level');
    await queryInterface.removeColumn('orders', 'risk_score');
  },
};
