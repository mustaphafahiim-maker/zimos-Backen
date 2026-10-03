'use strict';

/**
 * usage_counters (SPEC §17.4): what a store used in a calendar month —
 * orders, messages sent, AI requests, and the storage it holds. Kept by the
 * worker (billing/usageCounters.js). Whatever pricing is decided later will
 * need these numbers; nothing reads them to charge or restrict today.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('NOW()');
    await queryInterface.createTable('usage_counters', {
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // 'YYYY-MM', UTC.
      period: { type: DataTypes.STRING(7), allowNull: false, primaryKey: true },
      orders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      messages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ai_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      storage_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    });
    await queryInterface.addIndex('usage_counters', ['period'], { name: 'usage_counters_period_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('usage_counters');
  },
};
