'use strict';

/**
 * Push notifications to the merchant's devices (SPEC §20: "a `device_tokens`
 * table (`userId`, `platform`, `token`, `lastSeenAt`)"; first the dashboard
 * PWA's web push, later the mobile app's). One row per browser or phone a
 * person turned notifications on in. `push` joins the notification log's
 * channels so each delivery is recorded like an email or a WhatsApp.
 *
 * Down drops the table; Postgres cannot drop an enum value in place, so
 * `push` stays in the channel type (unused) — harmless.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('device_tokens', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      // web | ios | android
      platform: { type: DataTypes.STRING(10), allowNull: false },
      // web: the browser's push subscription (JSON); ios/android: the push token.
      token: { type: DataTypes.TEXT, allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false },
      user_agent: { type: DataTypes.STRING(300), allowNull: true },
      last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('device_tokens', ['user_id', 'token_hash'], { unique: true, name: 'device_tokens_user_token_uniq' });
    await queryInterface.sequelize.query("ALTER TYPE enum_notification_logs_channel ADD VALUE IF NOT EXISTS 'push'");
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('device_tokens');
  },
};
