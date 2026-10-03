'use strict';

/**
 * order_status_history: every move of an order from one pipeline stage to
 * the next — who moved it, when and why.
 *
 * The stage itself stays derived (orders/orderStage.js): this table is the
 * record of its changes, written by orders/orderStatusHistory.js from the
 * places that change an order's state (orderStateService, the shipment
 * lifecycle, cancellation, the online payment paths). `from_status` /
 * `to_status` hold stage keys.
 *
 * `actor_type` is user | system | carrier | customer | api; `actor_id` is the
 * user or the API key, and has no foreign key because it names either.
 *
 * `id` is a sequence, not a uuid: two rows written in one transaction must
 * still read back in the order they happened.
 *
 * Every order that already exists gets one baseline row (nothing → the stage
 * it is in today), so the first real change after this migration has a
 * `from_status`. The expression below is the stage as it was defined when
 * this migration was written, copied here on purpose: a migration must keep
 * meaning the same thing after orderStage.js moves on.
 */
const STAGE_AT_135 = `CASE
      WHEN o.cancelled_at IS NOT NULL OR o.confirmation_state = 'rejected' THEN 'cancelled'
      WHEN ls.status = 'returned' THEN 'returned'
      WHEN ls.status = 'delivered' THEN 'delivered'
      WHEN ls.status = 'failed' THEN 'delivery_failed'
      WHEN ls.status = 'out_for_delivery' THEN 'out_for_delivery'
      WHEN ls.status IN ('picked_up', 'in_transit') THEN 'shipped'
      WHEN ls.status IS NULL AND o.fulfillment_state = 'returned' THEN 'returned'
      WHEN ls.status IS NULL AND o.fulfillment_state = 'fulfilled' THEN 'delivered'
      WHEN (o.payment_method <> 'cod' AND o.financial_state NOT IN ('paid', 'partially_paid', 'refunded', 'partially_refunded')) THEN 'awaiting_payment'
      WHEN o.confirmation_state IN ('unreachable', 'postponed') THEN 'needs_follow_up'
      WHEN o.confirmation_state = 'pending' AND o.payment_method = 'cod' THEN 'pending_confirmation'
      ELSE 'ready_to_ship'
    END`;

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('order_status_history', {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      from_status: { type: DataTypes.STRING(40), allowNull: true },
      to_status: { type: DataTypes.STRING(40), allowNull: false },
      actor_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'system' },
      actor_id: { type: DataTypes.UUID, allowNull: true },
      reason: { type: DataTypes.STRING(500), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('order_status_history', ['order_id', 'id'], {
      name: 'order_status_history_order_idx',
    });
    await queryInterface.addIndex('order_status_history', ['workspace_id', 'created_at'], {
      name: 'order_status_history_workspace_created_idx',
    });

    await queryInterface.sequelize.query(
      `INSERT INTO order_status_history (workspace_id, order_id, from_status, to_status, actor_type, reason, created_at)
       SELECT o.workspace_id, o.id, NULL, ${STAGE_AT_135}, 'system', 'baseline', o.created_at
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT s.status
             FROM shipments s
            WHERE s.order_id = o.id
              AND s.status <> 'cancelled'
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT 1
         ) ls ON TRUE
        ORDER BY o.created_at ASC`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('order_status_history');
  },
};
