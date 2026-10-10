'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A message sent to a customer about an order (the order emails, an
 * automation's SMS or email) remembers that order and what it said in a line
 * (`subject`: an email's subject, an SMS's first words), so the order's
 * timeline can list the messages it sent (orders/orderTimeline.js). Both stay
 * null for anything else (sign-in codes, staff notifications).
 *
 * Additive and run-twice safe: two nullable columns, and a partial index the
 * guard builds CONCURRENTLY (a table this migration did not create).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('notification_logs', 'order_id', { type: Sequelize.UUID, allowNull: true });
    await qi.addColumn('notification_logs', 'subject', { type: Sequelize.STRING(300), allowNull: true });
    await qi.addIndex('notification_logs', ['order_id', 'created_at'], { name: 'notification_logs_order_idx', where: { order_id: { [Sequelize.Op.ne]: null } } });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeIndex('notification_logs', 'notification_logs_order_idx');
    await qi.removeColumn('notification_logs', 'subject');
    await qi.removeColumn('notification_logs', 'order_id');
  },
};
