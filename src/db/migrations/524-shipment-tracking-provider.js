'use strict';

/**
 * Tracking for manual and imported waybills (item 387,
 * shipping/trackingProviders): what the store's tracking provider knows of a
 * shipment that was not booked through a connected courier, and when the
 * tracking job reads it next. Kept apart from next_poll_at / poll_failures,
 * which belong to the courier poller (carrierSyncService).
 *
 *   tracking_state          { provider, ref, waybill, courier, registeredAt,
 *                             appliedAt, lastCheckpointAt, lastStatus, seen[] }
 *   tracking_next_poll_at   null = not scheduled yet (the job picks it up) or
 *                           never again once the shipment is final
 *   tracking_failures       consecutive failed reads (backoff)
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('shipments', 'tracking_state', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn('shipments', 'tracking_next_poll_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('shipments', 'tracking_failures', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    // The job's scan: live shipments with a waybill that no courier account booked.
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS shipments_manual_tracking_idx
         ON shipments (workspace_id, created_at)
      WHERE waybill_number IS NOT NULL
        AND status NOT IN ('delivered', 'returned', 'cancelled')
        AND (carrier_response IS NULL OR carrier_response->'carrierShipmentId' IS NULL)`
    );
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS shipments_manual_tracking_idx');
    await queryInterface.removeColumn('shipments', 'tracking_failures');
    await queryInterface.removeColumn('shipments', 'tracking_next_poll_at');
    await queryInterface.removeColumn('shipments', 'tracking_state');
  },
};
