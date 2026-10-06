'use strict';

/**
 * Shipping many orders with a courier in one go (SPEC §12.4 "Ship
 * selected"): a batch, and one item per order with what happened to it.
 * The carriers queue books the items one by one (shipping/bulkShipping.js);
 * the merchant reads the report and sends the failed ones again.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('shipment_batches', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      carrier_code: { type: DataTypes.STRING(100), allowNull: false },
      // queued | running | done
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('shipment_batches', ['workspace_id', 'created_at'], { name: 'shipment_batches_workspace_idx' });

    await queryInterface.createTable('shipment_batch_items', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'shipment_batches', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      workspace_id: { type: DataTypes.UUID, allowNull: false },
      order_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      // pending | booking | booked | failed
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      // The courier place chosen for this order in the dialog: { path: [...] }.
      carrier_address: { type: DataTypes.JSONB, allowNull: true },
      shipment_id: { type: DataTypes.UUID, allowNull: true },
      waybill_number: { type: DataTypes.STRING(100), allowNull: true },
      error_code: { type: DataTypes.STRING(100), allowNull: true },
      error_message: { type: DataTypes.STRING(500), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('shipment_batch_items', ['batch_id', 'order_id'], { unique: true, name: 'shipment_batch_items_order_uniq' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('shipment_batch_items');
    await queryInterface.dropTable('shipment_batches');
  },
};
