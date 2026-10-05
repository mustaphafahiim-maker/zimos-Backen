'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Merchant notifications (SPEC §14.6) — the bell in the dashboard.
 *
 * notifications: one row per person who should see it. A store-wide event (a
 * new order) is fanned out to every teammate whose role may see it and whose
 * preferences ask for it, so "read" is a plain per-row timestamp. `user_id`
 * stays nullable as the spec has it: a null row is shown to the whole team and
 * shares one read state.
 *
 * `dedupe_key` keeps a repeated cause from stacking rows (a variant that stays
 * low on stock, a platform announcement already delivered): unique per
 * workspace + user.
 *
 * notification_preferences: per teammate per store — which types they want in
 * the dashboard and by email, and whether a new order plays a sound.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const timestamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    };
    const workspace = {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    };
    const user = (allowNull) => ({
      type: DataTypes.UUID,
      allowNull,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('notifications', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: workspace,
      user_id: user(true),
      type: { type: DataTypes.STRING(50), allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: true },
      link: { type: DataTypes.STRING(500), allowNull: true },
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      dedupe_key: { type: DataTypes.STRING(200), allowNull: true },
      read_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('notifications', ['workspace_id', 'user_id', 'created_at'], {
      name: 'notifications_inbox_idx',
    });
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications
         (workspace_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key)
       WHERE dedupe_key IS NOT NULL`
    );

    await queryInterface.createTable('notification_preferences', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: workspace,
      user_id: user(false),
      channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      sound_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...timestamps,
    });
    await queryInterface.addIndex('notification_preferences', ['workspace_id', 'user_id'], {
      name: 'notification_preferences_member_idx',
      unique: true,
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('notification_preferences');
    await queryInterface.dropTable('notifications');
  },
};
