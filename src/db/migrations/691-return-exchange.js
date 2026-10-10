'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Returns become exchanges, with the answer the shopper hears
 * (modules/returns/returnExchange.js):
 *
 *   resolution         'refund' (as before) | 'exchange' (VARCHAR + CHECK):
 *                      the shopper wants another variant of the same product;
 *                      each item line then names its exchangeVariantId
 *   exchange_order_id  the replacement order made when an exchange is
 *                      approved (SET NULL if that order is deleted)
 *   decision_note      what the merchant told the shopper with the decision
 *   decided_at         when the return was approved or rejected
 *
 * The courier pickup column of the same change is not added: the return
 * pickup is not ported. Additive and run-twice safe.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    await qi.addColumn('return_requests', 'resolution', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'refund' });
    await qi.addColumn('return_requests', 'exchange_order_id', { type: Sequelize.UUID, allowNull: true, references: { model: 'orders', key: 'id' }, onDelete: 'SET NULL' });
    await qi.addColumn('return_requests', 'decision_note', { type: Sequelize.STRING(500), allowNull: true });
    await qi.addColumn('return_requests', 'decided_at', { type: Sequelize.DATE, allowNull: true });
    const [[has]] = await sequelize.query("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'return_requests_resolution_check'");
    if (!has.n) {
      await sequelize.query("ALTER TABLE return_requests ADD CONSTRAINT return_requests_resolution_check CHECK (resolution IN ('refund', 'exchange')) NOT VALID");
      await sequelize.query('ALTER TABLE return_requests VALIDATE CONSTRAINT return_requests_resolution_check');
    }
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query('ALTER TABLE return_requests DROP CONSTRAINT IF EXISTS return_requests_resolution_check');
    await qi.removeColumn('return_requests', 'decided_at');
    await qi.removeColumn('return_requests', 'decision_note');
    await qi.removeColumn('return_requests', 'exchange_order_id');
    await qi.removeColumn('return_requests', 'resolution');
  },
};
