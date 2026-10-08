'use strict';

/**
 * Team channels: a store's alerts in a Telegram group, a Slack channel or a
 * Discord channel (item 378, notifications/teamChannels).
 *
 * team_channels, one row per place the store's alerts go (not a teammate):
 *   provider     telegram | slack | discord
 *   name         what the merchant calls it ("Orders group")
 *   credentials  sealed (core/utils/secretBox): the bot token and chat id, or
 *                the incoming-webhook URL; never returned by the API
 *   hint         what the settings screen shows instead (chat id, ••••abcd)
 *   locale       ar | en, the language its messages are written in
 *   types        the notification types it receives (merchantNotificationService TYPES)
 *   is_active    false once paused by the merchant or after 10 failures in a row
 *   last_status, last_error, last_sent_at, failure_count  its health
 *
 * team_channel_deliveries, one row per message sent or tried. A notification's
 * dedupe key reaches a channel at most once (partial unique index). Rows older
 * than 30 days are pruned (notifications/jobs.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('team_channels', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      provider: { type: Sequelize.STRING(20), allowNull: false },
      name: { type: Sequelize.STRING(100), allowNull: false },
      credentials: { type: Sequelize.TEXT, allowNull: false },
      hint: { type: Sequelize.STRING(120), allowNull: true },
      locale: { type: Sequelize.STRING(2), allowNull: false, defaultValue: 'ar' },
      types: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_status: { type: Sequelize.STRING(20), allowNull: true },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      last_sent_at: { type: Sequelize.DATE, allowNull: true },
      failure_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by_user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.sequelize.query(
      "ALTER TABLE team_channels ADD CONSTRAINT team_channels_provider_check CHECK (provider IN ('telegram', 'slack', 'discord'));"
    );
    await queryInterface.addIndex('team_channels', ['workspace_id'], { name: 'team_channels_ws_idx' });

    await queryInterface.createTable('team_channel_deliveries', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      team_channel_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'team_channels', key: 'id' }, onDelete: 'CASCADE' },
      type: { type: Sequelize.STRING(60), allowNull: false },
      dedupe_key: { type: Sequelize.STRING(200), allowNull: true },
      status: { type: Sequelize.STRING(20), allowNull: false },
      error: { type: Sequelize.STRING(500), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX team_channel_deliveries_dedupe_uq ON team_channel_deliveries (team_channel_id, dedupe_key) WHERE dedupe_key IS NOT NULL;'
    );
    await queryInterface.addIndex('team_channel_deliveries', ['team_channel_id', 'created_at'], { name: 'team_channel_deliveries_channel_idx' });
    await queryInterface.addIndex('team_channel_deliveries', ['created_at'], { name: 'team_channel_deliveries_created_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('team_channel_deliveries');
    await queryInterface.dropTable('team_channels');
  },
};
