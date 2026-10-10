'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Returns asked for by the shopper (modules/returns/shopperReturns.js,
 * STORE_FEATURES shopper_returns): who opened it (merchant | shopper,
 * VARCHAR + CHECK) and the photos they attached (customer_uploads ids).
 *
 * Additive and run-twice safe: constant defaults (no rewrite); the CHECK is
 * added NOT VALID then validated.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    await qi.addColumn('return_requests', 'source', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'merchant' });
    await qi.addColumn('return_requests', 'photo_upload_ids', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    const [[has]] = await sequelize.query("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'return_requests_source_check'");
    if (!has.n) {
      await sequelize.query("ALTER TABLE return_requests ADD CONSTRAINT return_requests_source_check CHECK (source IN ('merchant', 'shopper')) NOT VALID");
      await sequelize.query('ALTER TABLE return_requests VALIDATE CONSTRAINT return_requests_source_check');
    }
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query('ALTER TABLE return_requests DROP CONSTRAINT IF EXISTS return_requests_source_check');
    await qi.removeColumn('return_requests', 'photo_upload_ids');
    await qi.removeColumn('return_requests', 'source');
  },
};
