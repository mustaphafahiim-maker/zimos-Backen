'use strict';

/**
 * The time the customer asked to be called back ("call me tomorrow at 5"),
 * on a postponed or unreachable call (cod/confirmationService.js applyOutcome).
 * The task is due again at that time (next_retry_at); null = the default delay.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('confirmation_tasks', 'callback_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('confirmation_tasks', 'callback_at');
  },
};
