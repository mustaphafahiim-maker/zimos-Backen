'use strict';

/**
 * What a product really costs to sell, beyond the unit cost already on its
 * variants: packaging, the courier's real outbound and return charges, the
 * collection and gateway fee percentages, and the share that arrives damaged.
 * The row with product_id NULL holds the store's defaults; a product row
 * overrides only the fields it sets.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    await queryInterface.createTable('product_economics', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      product_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      packaging_cost_amount: { type: DataTypes.BIGINT, allowNull: true },
      shipping_cost_amount: { type: DataTypes.BIGINT, allowNull: true },
      return_cost_amount: { type: DataTypes.BIGINT, allowNull: true },
      collection_fee_bp: { type: DataTypes.INTEGER, allowNull: true },
      gateway_fee_bp: { type: DataTypes.INTEGER, allowNull: true },
      damage_bp: { type: DataTypes.INTEGER, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX product_economics_ws_product_uq ON product_economics (workspace_id, product_id) WHERE product_id IS NOT NULL'
    );
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX product_economics_ws_default_uq ON product_economics (workspace_id) WHERE product_id IS NULL'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('product_economics');
  },
};
