'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Delivery zones inside a city (shipping/deliveryZones.js): areas a store
 * that delivers itself writes on its own — "Nasr City", "Heliopolis" — each
 * with its fee, an optional minimum order and an estimated time in minutes.
 * Used at checkout only while settings.delivery_zones_enabled is on.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') };
    await queryInterface.createTable('delivery_zones', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      // Minor units.
      fee_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      min_order_amount: { type: DataTypes.BIGINT, allowNull: true },
      eta_minutes: { type: DataTypes.INTEGER, allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('delivery_zones', ['workspace_id', 'sort_order'], { name: 'delivery_zones_workspace_sort_idx' });
    await queryInterface.sequelize.query(
      'ALTER TABLE delivery_zones DROP CONSTRAINT IF EXISTS delivery_zones_amounts_check'
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE delivery_zones ADD CONSTRAINT delivery_zones_amounts_check
         CHECK (fee_amount >= 0 AND (min_order_amount IS NULL OR min_order_amount >= 0) AND (eta_minutes IS NULL OR eta_minutes BETWEEN 1 AND 1440))`
    );
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('delivery_zones');
  },
};
