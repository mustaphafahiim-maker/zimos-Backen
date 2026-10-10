'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Scheduled summary reports (modules/scheduledReports, STORE_FEATURES
 * scheduled_reports): one row per store, report kind (daily | weekly,
 * VARCHAR + CHECK) and period sent, so a report goes out once however often
 * the schedule runs or how many workers there are. A new table, skipped when
 * present.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const created = await qi.createTable('report_deliveries', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      kind: { type: Sequelize.STRING(10), allowNull: false },
      // The store-local date the report was due (YYYY-MM-DD).
      period_key: { type: Sequelize.STRING(10), allowNull: false },
      sent_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (created) await queryInterface.sequelize.query("ALTER TABLE report_deliveries ADD CONSTRAINT report_deliveries_kind_check CHECK (kind IN ('daily', 'weekly'))");
    await qi.addIndex('report_deliveries', ['workspace_id', 'kind', 'period_key'], { name: 'report_deliveries_uq', unique: true });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('report_deliveries');
  },
};
