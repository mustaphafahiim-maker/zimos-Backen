'use strict';

/**
 * COD settlements: the merchant records a courier's cash remittance (which
 * delivered orders it covers, cash collected, courier fees). Confirming it
 * records real payments on those orders. An order can be settled only once.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const workspaceRef = { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' };
    const userRef = { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' };

    await queryInterface.createTable('cod_settlements', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspaceRef,
      carrier_code: { type: DataTypes.STRING(100), allowNull: false },
      reference: { type: DataTypes.STRING(120), allowNull: true },
      period_start: { type: DataTypes.DATEONLY, allowNull: true },
      period_end: { type: DataTypes.DATEONLY, allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      collected_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      fees_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      net_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      notes: { type: DataTypes.STRING(1000), allowNull: true },
      created_by_user_id: userRef,
      confirmed_by_user_id: userRef,
      confirmed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('cod_settlements', ['workspace_id', 'status']);

    await queryInterface.createTable('cod_settlement_lines', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspaceRef,
      settlement_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'cod_settlements', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      order_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      shipment_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'shipments', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      collected_amount: { type: DataTypes.BIGINT, allowNull: false },
      fee_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('cod_settlement_lines', ['workspace_id', 'order_id'], { unique: true, name: 'cod_settlement_lines_ws_order_uq' });
    await queryInterface.addIndex('cod_settlement_lines', ['settlement_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('cod_settlement_lines');
    await queryInterface.dropTable('cod_settlements');
  },
};
