'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The console's notifications (platformAdmin/platformNotificationService):
 *
 *   platform_notifications       one row per event, for every console admin
 *                                (type, title, body, link, data, who did it,
 *                                who/what it is about). dedupe_key keeps a
 *                                scheduled one (expiring, expired) to one row.
 *   platform_notification_reads  which admin has read which row
 *   platform_notification_prefs  per admin and type: shown in the console
 *                                (default on) and by email (default off; no
 *                                email is sent yet, the choice is only kept)
 */
const TYPES = [
  'user_signup',
  'workspace_created',
  'subscription_activated',
  'subscription_expiring',
  'subscription_expired',
  'payment_proof_submitted',
  'payment_failed',
  'support_ticket',
  'referral_signup',
  'user_suspended',
];
const typeCheck = `type IN (${TYPES.map((t) => `'${t}'`).join(', ')})`;

module.exports = {

  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'platform_notifications',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          type: { type: DataTypes.STRING(40), allowNull: false },
          title: { type: DataTypes.STRING(200), allowNull: false },
          body: { type: DataTypes.TEXT, allowNull: true },
          link: { type: DataTypes.STRING(500), allowNull: true },
          data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          actor_user_id: { type: DataTypes.UUID, allowNull: true },
          subject_user_id: { type: DataTypes.UUID, allowNull: true },
          workspace_id: { type: DataTypes.UUID, allowNull: true },
          dedupe_key: { type: DataTypes.STRING(200), allowNull: true },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE platform_notifications DROP CONSTRAINT IF EXISTS platform_notifications_type_check', { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE platform_notifications ADD CONSTRAINT platform_notifications_type_check CHECK (${typeCheck})`, { transaction });
      await queryInterface.addIndex('platform_notifications', ['created_at', 'id'], { name: 'platform_notifications_created_idx', transaction });
      await queryInterface.addIndex('platform_notifications', ['type', 'created_at'], { name: 'platform_notifications_type_idx', transaction });
      await queryInterface.addIndex('platform_notifications', ['dedupe_key'], {
        name: 'platform_notifications_dedupe_key_unique',
        unique: true,
        where: { dedupe_key: { [Sequelize.Op.ne]: null } },
        transaction,
      });

      await queryInterface.createTable(
        'platform_notification_reads',
        {
          user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
          notification_id: {
            type: DataTypes.UUID,
            allowNull: false,
            primaryKey: true,
            references: { model: 'platform_notifications', key: 'id' },
            onDelete: 'CASCADE',
          },
          read_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );

      await queryInterface.createTable(
        'platform_notification_prefs',
        {
          user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
          type: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
          enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
          email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query('ALTER TABLE platform_notification_prefs DROP CONSTRAINT IF EXISTS platform_notification_prefs_type_check', { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE platform_notification_prefs ADD CONSTRAINT platform_notification_prefs_type_check CHECK (${typeCheck})`, { transaction });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('platform_notification_prefs', { transaction });
      await queryInterface.dropTable('platform_notification_reads', { transaction });
      await queryInterface.dropTable('platform_notifications', { transaction });
    });
  },
};
