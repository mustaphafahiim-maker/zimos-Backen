'use strict';

/**
 * Partial fulfilment (item 375, shipping/partialShipments.js).
 *
 * shipments.items     [{ orderItemId, quantity }] — the units this parcel
 *                     carries; null for a parcel that carries the whole order
 *                     (every shipment before this migration).
 * shipments.cod_amount what the courier collects for this parcel, in minor
 *                     units; null for a whole-order parcel, which keeps
 *                     collecting what the order still owes.
 *
 * A COD settlement line was unique per order; a split order is settled per
 * delivered parcel, so the key becomes (workspace, order, shipment).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('shipments', 'items', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn('shipments', 'cod_amount', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.removeIndex('cod_settlement_lines', 'cod_settlement_lines_ws_order_uq');
    await queryInterface.addIndex('cod_settlement_lines', ['workspace_id', 'order_id', 'shipment_id'], {
      unique: true,
      name: 'cod_settlement_lines_ws_order_shipment_uq',
    });
  },
  down: async (queryInterface) => {
    // Fails while an order has two settlement lines (two settled parcels).
    await queryInterface.removeIndex('cod_settlement_lines', 'cod_settlement_lines_ws_order_shipment_uq');
    await queryInterface.addIndex('cod_settlement_lines', ['workspace_id', 'order_id'], { unique: true, name: 'cod_settlement_lines_ws_order_uq' });
    await queryInterface.removeColumn('shipments', 'cod_amount');
    await queryInterface.removeColumn('shipments', 'items');
  },
};
