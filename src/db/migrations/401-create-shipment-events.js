'use strict';

/**
 * Every state a courier reported for a shipment (SPEC §12.2 "shipment log"),
 * kept in order: carriers move through more states than our eight statuses
 * ("arrived at hub", "delivery attempt failed"…), and shipments.carrier_response
 * keeps only the latest. Written by carrierShipmentService.applyCarrierStatus
 * (webhook, poller, sync); shown on the order's timeline.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('shipment_events', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      shipment_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'shipments', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      order_id: { type: DataTypes.UUID, allowNull: false },
      carrier_code: { type: DataTypes.STRING(100), allowNull: false },
      // Our status after the report (unchanged when the courier's move means nothing to us).
      status: { type: DataTypes.STRING(30), allowNull: true },
      carrier_status_code: { type: DataTypes.STRING(100), allowNull: true },
      description: { type: DataTypes.STRING(300), allowNull: true },
      // webhook | poll | sync — how the report arrived.
      trigger: { type: DataTypes.STRING(20), allowNull: true },
      occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('shipment_events', ['shipment_id', 'occurred_at'], { name: 'shipment_events_shipment_idx' });
    await queryInterface.addIndex('shipment_events', ['workspace_id', 'order_id'], { name: 'shipment_events_order_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('shipment_events');
  },
};
