'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Advertising spend per day, platform and campaign. Filled by hand, from a
 * CSV, or by the ads sync job; one row per (day, platform, campaign), so a
 * re-import of the same day replaces the amount rather than doubling it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    await queryInterface.createTable('ad_spend_daily', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      day: { type: DataTypes.DATEONLY, allowNull: false },
      platform: { type: DataTypes.STRING(30), allowNull: false },
      campaign_name: { type: DataTypes.STRING(200), allowNull: false },
      campaign_key: { type: DataTypes.STRING(200), allowNull: false },
      campaign_id: { type: DataTypes.STRING(100), allowNull: true },
      spend_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      impressions: { type: DataTypes.INTEGER, allowNull: true },
      clicks: { type: DataTypes.INTEGER, allowNull: true },
      source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' },
      created_by_user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('ad_spend_daily', ['workspace_id', 'day', 'platform', 'campaign_key'], {
      unique: true,
      name: 'ad_spend_daily_ws_day_platform_campaign_uq',
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('ad_spend_daily');
  },
};
