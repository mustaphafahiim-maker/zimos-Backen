'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Shipping groups (SPEC §12.1 "a set of prices linked to specific products —
 * a heavy product at a higher price"; implementation step 3:
 * `shipping_profiles` + `products.shippingProfileId`).
 *
 * A profile has a price everywhere (`flat_amount`) and, optionally, its own
 * price per governorate (`governorate_amounts`, code → minor units). Products
 * in no profile keep the store's rates.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('shipping_profiles', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      flat_amount: { type: DataTypes.BIGINT, allowNull: true },
      governorate_amounts: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('shipping_profiles', ['workspace_id'], { name: 'shipping_profiles_workspace_idx' });
    await queryInterface.addColumn('products', 'shipping_profile_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'shipping_profiles', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('products', 'shipping_profile_id');
    await queryInterface.dropTable('shipping_profiles');
  },
};
