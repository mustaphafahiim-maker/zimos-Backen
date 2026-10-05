'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The sign-ups a funnel session made on its opt-in steps
 * (funnels/funnelOptIn.js): { [stepKey]: { submissionId, customerId, at } }.
 * The step's "Opt-ins" count reads this, and the session cannot move past an
 * opt-in step without an entry for it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('funnel_sessions', 'opt_ins', { type: Sequelize.JSONB, allowNull: false, defaultValue: {} });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('funnel_sessions', 'opt_ins');
  },
};
