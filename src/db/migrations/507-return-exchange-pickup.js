'use strict';

/**
 * Returns become exchanges, courier pickups and answers the shopper hears
 * (item 372).
 *
 *   resolution         'refund' (as before) | 'exchange': the shopper wants
 *                      another variant of the same product; each item line
 *                      then names its exchangeVariantId
 *   exchange_order_id  the replacement order made when an exchange is
 *                      approved (SET NULL if that order is deleted)
 *   decision_note      what the merchant told the shopper with the decision
 *   decided_at         when the return was approved or rejected
 *   pickup             the courier booked to collect the parcel from the
 *                      shopper: { carrierCode, waybillNumber, trackingUrl,
 *                      carrierShipmentId, bookedAt, bookedBy }; null = none
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('return_requests', 'resolution', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'refund' });
    await queryInterface.addColumn('return_requests', 'exchange_order_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'orders', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('return_requests', 'decision_note', { type: Sequelize.STRING(500), allowNull: true });
    await queryInterface.addColumn('return_requests', 'decided_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('return_requests', 'pickup', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('return_requests', 'pickup');
    await queryInterface.removeColumn('return_requests', 'decided_at');
    await queryInterface.removeColumn('return_requests', 'decision_note');
    await queryInterface.removeColumn('return_requests', 'exchange_order_id');
    await queryInterface.removeColumn('return_requests', 'resolution');
  },
};
