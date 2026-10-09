'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Two-step sign-in (auth/twoFactorService), behind TWO_FACTOR_ENABLED.
 *
 * user_two_factor   a person's two-step sign-in: off, a code by email or
 *                   WhatsApp, or an authenticator app (TOTP). The secret is
 *                   sealed (core/utils/secretBox).
 * login_challenges  a sign-in waiting for its second step.
 * trusted_devices   browsers that passed the second step and asked to be
 *                   remembered (only a hash of the device cookie).
 *
 * New tables only, each skipped when present. mode and channel are
 * VARCHAR + CHECK. down() drops these tables only.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('NOW()');
    const id = { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') };
    const stamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    };
    const user = { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' };

    if (await qi.createTable('user_two_factor', {
      user_id: { ...user, primaryKey: true },
      mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'off' },
      totp_secret_sealed: { type: DataTypes.TEXT, allowNull: true },
      // A secret being set up: becomes totp_secret_sealed once a code confirms it.
      pending_secret_sealed: { type: DataTypes.TEXT, allowNull: true },
      enabled_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps,
    })) {
      await queryInterface.sequelize.query(
        "ALTER TABLE user_two_factor ADD CONSTRAINT user_two_factor_mode_check CHECK (mode IN ('off', 'email', 'totp', 'whatsapp'))"
      );
    }

    if (await qi.createTable('login_challenges', {
      id,
      user_id: user,
      channel: { type: DataTypes.STRING(10), allowNull: false },
      code_hash: { type: DataTypes.STRING(64), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      ip_address: { type: DataTypes.STRING(64), allowNull: true },
      ...stamps,
    })) {
      await queryInterface.sequelize.query(
        "ALTER TABLE login_challenges ADD CONSTRAINT login_challenges_channel_check CHECK (channel IN ('email', 'totp', 'whatsapp', 'sms'))"
      );
    }
    await qi.addIndex('login_challenges', ['user_id', 'created_at'], { name: 'login_challenges_user_idx' });

    await qi.createTable('trusted_devices', {
      id,
      user_id: user,
      device_hash: { type: DataTypes.STRING(64), allowNull: false },
      user_agent: { type: DataTypes.STRING(500), allowNull: true },
      last_used_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      ...stamps,
    });
    await qi.addIndex('trusted_devices', ['user_id', 'device_hash'], { unique: true, name: 'trusted_devices_uq' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('trusted_devices');
    await queryInterface.dropTable('login_challenges');
    await queryInterface.dropTable('user_two_factor');
  },
};
