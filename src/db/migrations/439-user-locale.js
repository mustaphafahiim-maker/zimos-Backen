'use strict';

/**
 * The language a teammate uses the dashboard in ('ar' / 'en'), kept by the
 * dashboard as they switch it. Notifications that leave the dashboard — push,
 * email, WhatsApp — are written in it (notifications/merchantNotificationService.js).
 * Null: not known yet, Arabic.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'locale', { type: Sequelize.STRING(5), allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'locale');
  },
};
