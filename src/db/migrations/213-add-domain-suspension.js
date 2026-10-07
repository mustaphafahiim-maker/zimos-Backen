'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A custom domain stops being served, without being deleted, while its store
 * is suspended or (with PLAN_FEATURE_ENFORCEMENT on) its plan no longer
 * includes custom_domain. The domains job sets and clears it
 * (modules/domains/domainJobs.js):
 *
 *  - domains.suspended_at      when it stopped; null = served as before
 *  - domains.suspended_reason  store_suspended | plan (VARCHAR + CHECK)
 */
const REASONS = ['store_suspended', 'plan'];
const CHECK = 'domains_suspended_reason_check';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('domains', 'suspended_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('domains', 'suspended_reason', { type: DataTypes.STRING(20), allowNull: true });
    await queryInterface.addConstraint('domains', {
      type: 'check',
      name: CHECK,
      fields: ['suspended_reason'],
      where: { suspended_reason: REASONS },
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query(`ALTER TABLE domains DROP CONSTRAINT IF EXISTS ${CHECK}`);
    await queryInterface.removeColumn('domains', 'suspended_reason');
    await queryInterface.removeColumn('domains', 'suspended_at');
  },
};
