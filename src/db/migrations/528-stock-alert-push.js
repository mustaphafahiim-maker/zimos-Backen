'use strict';

/**
 * Back-in-stock alerts by push (item 392, notifications/push/stockAlertPush.js):
 * stock_alerts.push_token holds the shopper's browser subscription for an
 * alert with channel `push` (its target is the subscription's SHA-256, so
 * one browser waits once per variant). Cleared once the alert is sent.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('stock_alerts', 'push_token', { type: Sequelize.TEXT, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query("DELETE FROM stock_alerts WHERE channel = 'push'");
    await queryInterface.removeColumn('stock_alerts', 'push_token');
  },
};
