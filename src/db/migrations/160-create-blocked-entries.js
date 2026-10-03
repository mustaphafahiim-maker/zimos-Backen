'use strict';

/**
 * The store's blacklist, beyond phones: one row per blocked identifier
 * (phone, IP, email, device, name + address) and per scope — `orders` (may
 * not order), `otp` (is not sent a code), `visit` (does not see the store).
 *
 * `value` is the normalized form order creation compares against (see
 * modules/fraud/blockedEntries.js); `label` is what the merchant typed.
 *
 * customers.is_blacklisted keeps working and is mirrored here: every
 * blacklisted customer gets a (phone, orders) row, now and on every change.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };

    await queryInterface.createTable('blocked_entries', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      type: { type: DataTypes.STRING(20), allowNull: false },
      value: { type: DataTypes.STRING(255), allowNull: false },
      label: { type: DataTypes.STRING(600), allowNull: false },
      scope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'orders' },
      reason: { type: DataTypes.STRING(300), allowNull: true },
      created_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE blocked_entries
         ADD CONSTRAINT blocked_entries_type_check CHECK (type IN ('phone', 'ip', 'email', 'device', 'name_address')),
         ADD CONSTRAINT blocked_entries_scope_check CHECK (scope IN ('orders', 'otp', 'visit'))`
    );
    await queryInterface.addIndex('blocked_entries', ['workspace_id', 'type', 'scope', 'value'], {
      unique: true,
      name: 'blocked_entries_ws_type_scope_value_uq',
    });
    await queryInterface.addIndex('blocked_entries', ['workspace_id', 'created_at', 'id'], {
      name: 'blocked_entries_ws_created_idx',
    });

    await queryInterface.sequelize.query(
      `INSERT INTO blocked_entries (id, workspace_id, type, value, label, scope, reason, created_at, updated_at)
       SELECT gen_random_uuid(), c.workspace_id, 'phone', c.phone_normalized,
              COALESCE(NULLIF(c.phone_raw, ''), c.phone_normalized), 'orders', c.blacklist_reason,
              COALESCE(c.blacklisted_at, NOW()), NOW()
         FROM customers c
        WHERE c.is_blacklisted = TRUE
       ON CONFLICT DO NOTHING`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('blocked_entries');
  },
};
