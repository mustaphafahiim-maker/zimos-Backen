'use strict';

/**
 * A message sent to a customer about an order (the order emails, an
 * automation's SMS or email, a shopper push) remembers that order and what
 * it said in a line (`subject`: an email's subject, an SMS's first words, a
 * push's title), so the order's timeline can list the messages it sent
 * (orders/orderTimeline.js, SPEC §4.4 card 11). Both stay null for anything
 * else (sign-in codes, staff notifications).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('notification_logs', 'order_id', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn('notification_logs', 'subject', { type: Sequelize.STRING(300), allowNull: true });
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS notification_logs_order_idx ON notification_logs (order_id, created_at) WHERE order_id IS NOT NULL'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS notification_logs_order_idx');
    await queryInterface.removeColumn('notification_logs', 'subject');
    await queryInterface.removeColumn('notification_logs', 'order_id');
  },
};
