'use strict';

/**
 * Platform-wide delivery numbers per customer (SPEC §5.4).
 *
 * customer_network_stats has no workspace_id and no phone number: its key is
 * sha256(phone in digits-only E.164 + a secret pepper). A merchant only ever
 * sees the aggregated counters.
 *
 * customer_network_marks remembers which outcome each order was last counted
 * under, so an order that changes stage moves between counters instead of
 * being counted twice, and stores_count can be derived. It is internal: no
 * route reads it.
 *
 * customer_network_spam_reports keeps one "report as spam" per store and
 * customer.
 *
 * The FeatureFlag `customer_network_score` gates showing and using the
 * numbers; collecting them starts with this migration.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const counter = { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 };

    await queryInterface.createTable('customer_network_stats', {
      phone_hash: { type: DataTypes.STRING(64), primaryKey: true, allowNull: false },
      orders_total: counter,
      delivered: counter,
      returned_to_sender: counter,
      cancelled_after_confirm: counter,
      rejected: counter,
      spam_reports: counter,
      stores_count: counter,
      first_seen_at: now,
      last_seen_at: now,
    });

    await queryInterface.createTable('customer_network_marks', {
      order_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      phone_hash: { type: DataTypes.STRING(64), allowNull: false },
      // delivered | returned_to_sender | cancelled_after_confirm | rejected | null (still open)
      outcome: { type: DataTypes.STRING(30), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('customer_network_marks', ['phone_hash', 'workspace_id']);

    await queryInterface.createTable('customer_network_spam_reports', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      phone_hash: { type: DataTypes.STRING(64), allowNull: false },
      reported_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('customer_network_spam_reports', ['workspace_id', 'phone_hash'], {
      unique: true,
      name: 'customer_network_spam_reports_ws_hash_uq',
    });

    await queryInterface.sequelize.query(
      `INSERT INTO feature_flags (id, key, description, enabled, rollout, target_workspace_ids, created_at, updated_at)
       VALUES (gen_random_uuid(), 'customer_network_score',
               'Show and use the platform-wide customer delivery rate (bar on orders, network-score endpoint, min_network_delivery_rate rule, risk signals). Off until the terms of use cover aggregated data.',
               FALSE, 0, '[]'::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO NOTHING`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DELETE FROM feature_flags WHERE key = 'customer_network_score'`);
    await queryInterface.dropTable('customer_network_spam_reports');
    await queryInterface.dropTable('customer_network_marks');
    await queryInterface.dropTable('customer_network_stats');
  },
};
