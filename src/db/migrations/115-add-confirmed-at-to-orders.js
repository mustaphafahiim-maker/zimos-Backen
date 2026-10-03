'use strict';

/**
 * orders.confirmed_at — when the order's current confirmation happened.
 *
 * Written by orders/orderStateService.setConfirmationState, the only writer of
 * confirmation_state: set on a transition into 'confirmed', cleared on a
 * transition out of it (a manager correcting to rejected). So it is non-null
 * exactly while the order is confirmed, and the audit log keeps the history.
 *
 * Backfill, for orders confirmed today, from what really happened — nothing
 * is invented, and an order with no trace stays null:
 *   1. the latest audit row that moved the order into 'confirmed'
 *      (order.confirmation_state_change, written by that same function since
 *      the confirmation module existed);
 *   2. failing that, the latest confirmation task that finished 'confirmed'
 *      (its completed_at is stamped in the same transaction).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('orders', 'confirmed_at', { type: DataTypes.DATE, allowNull: true }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE orders o
            SET confirmed_at = h.confirmed_at
           FROM (
             SELECT a.entity_id, MAX(a.created_at) AS confirmed_at
               FROM audit_logs a
              WHERE a.action = 'order.confirmation_state_change'
                AND a.entity_type = 'Order'
                AND a.after_state->>'confirmationState' = 'confirmed'
                AND (a.before_state->>'confirmationState') IS DISTINCT FROM 'confirmed'
              GROUP BY a.entity_id
           ) h
          WHERE o.id::text = h.entity_id
            AND o.confirmation_state = 'confirmed'`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `UPDATE orders o
            SET confirmed_at = t.confirmed_at
           FROM (
             SELECT order_id, MAX(completed_at) AS confirmed_at
               FROM confirmation_tasks
              WHERE outcome = 'confirmed' AND completed_at IS NOT NULL
              GROUP BY order_id
           ) t
          WHERE o.id = t.order_id
            AND o.confirmation_state = 'confirmed'
            AND o.confirmed_at IS NULL`,
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'confirmed_at');
  },
};
