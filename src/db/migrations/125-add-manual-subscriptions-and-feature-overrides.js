'use strict';

/**
 * Two things a platform admin can now do to one store by hand.
 *
 *  - subscription_manual_changes: every manual subscription action —
 *    activate (a plan for a period), change_plan (dates kept), extend,
 *    end_now — with source 'manual_admin', who did it and why (note
 *    required), the plan, status and period before and after. The
 *    subscription row itself (one per store) is what the billing lifecycle
 *    reads; this is its history. An optional Idempotency-Key is kept per
 *    store so a double click makes one change.
 *
 *  - workspace_feature_overrides: a feature granted to or taken from one
 *    store on top of its plan (billing/featureCatalog.js keys only), with an
 *    optional expiry, a reason, who granted it, and revocation. At most one
 *    live (not revoked) override per store and key.
 *
 * Both are new, empty tables: their indexes need no CONCURRENTLY.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));

    if (!tables.includes('subscription_manual_changes')) {
      await queryInterface.createTable('subscription_manual_changes', {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
        subscription_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'subscriptions', key: 'id' },
          onDelete: 'CASCADE',
        },
        action: { type: DataTypes.STRING(20), allowNull: false },
        source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual_admin' },
        plan_id_before: { type: DataTypes.UUID, allowNull: true },
        plan_id_after: { type: DataTypes.UUID, allowNull: true },
        status_before: { type: DataTypes.STRING(20), allowNull: true },
        status_after: { type: DataTypes.STRING(20), allowNull: true },
        period_start_before: { type: DataTypes.DATE, allowNull: true },
        period_end_before: { type: DataTypes.DATE, allowNull: true },
        period_start_after: { type: DataTypes.DATE, allowNull: true },
        period_end_after: { type: DataTypes.DATE, allowNull: true },
        note: { type: DataTypes.TEXT, allowNull: false },
        actor_user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
        idempotency_key: { type: DataTypes.STRING(200), allowNull: true },
        request_hash: { type: DataTypes.STRING(64), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE subscription_manual_changes
           ADD CONSTRAINT subscription_manual_changes_action_check
             CHECK (action IN ('activate', 'change_plan', 'extend', 'end_now')),
           ADD CONSTRAINT subscription_manual_changes_source_check CHECK (source = 'manual_admin'),
           ADD CONSTRAINT subscription_manual_changes_note_check CHECK (length(trim(note)) > 0)`
      );
      await queryInterface.addIndex('subscription_manual_changes', ['workspace_id', 'created_at'], {
        name: 'subscription_manual_changes_workspace_created_idx',
      });
      await queryInterface.addIndex('subscription_manual_changes', ['workspace_id', 'idempotency_key'], {
        name: 'subscription_manual_changes_idempotency_unique',
        unique: true,
        where: { idempotency_key: { [Sequelize.Op.ne]: null } },
      });
    }

    if (!tables.includes('workspace_feature_overrides')) {
      await queryInterface.createTable('workspace_feature_overrides', {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
        feature_key: { type: DataTypes.STRING(60), allowNull: false },
        mode: { type: DataTypes.STRING(10), allowNull: false },
        value: { type: DataTypes.JSONB, allowNull: true },
        expires_at: { type: DataTypes.DATE, allowNull: true },
        reason: { type: DataTypes.TEXT, allowNull: false },
        granted_by: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
        revoked_by: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
        revoke_reason: { type: DataTypes.TEXT, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE workspace_feature_overrides
           ADD CONSTRAINT workspace_feature_overrides_mode_check CHECK (mode IN ('grant', 'deny')),
           ADD CONSTRAINT workspace_feature_overrides_reason_check CHECK (length(trim(reason)) > 0)`
      );
      await queryInterface.addIndex('workspace_feature_overrides', ['workspace_id', 'feature_key'], {
        name: 'workspace_feature_overrides_live_unique',
        unique: true,
        where: { revoked_at: null },
      });
    }
  },

  down: async (queryInterface) => {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));
    if (tables.includes('workspace_feature_overrides')) await queryInterface.dropTable('workspace_feature_overrides');
    if (tables.includes('subscription_manual_changes')) await queryInterface.dropTable('subscription_manual_changes');
  },
};
