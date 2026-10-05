'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Daily event counts per store day (SPEC §15.1: "computation comes from daily
 * aggregate tables `analytics_daily` (workspace, day, funnel, metrics)
 * updated by the worker, not a query on raw events every time").
 *
 * One row per store-local day for the whole store (`funnel_key` = '') and
 * one per funnel that had events that day. `computed_at` says whether the
 * row was counted after its day ended (analytics/analyticsDaily.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('analytics_daily', {
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      day: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
      // '' = the whole store; otherwise a funnel id.
      funnel_key: { type: DataTypes.STRING(36), allowNull: false, defaultValue: '', primaryKey: true },
      metrics: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      computed_at: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('analytics_daily');
  },
};
