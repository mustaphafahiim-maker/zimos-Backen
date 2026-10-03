'use strict';

/**
 * The app store (SPEC §16.6) and the app install link (§16.3).
 *
 * apps            the platform's catalogue. Rows are created from
 *                 modules/apps/appCatalogue.js; what the platform admin owns
 *                 here is is_active, the display order and — once pricing is
 *                 decided — price_amount/billing (no price lives in code).
 * workspace_apps  what a store installed: a catalogue app (app_key), or an
 *                 outside company's app that came through the install link
 *                 (kind = external, its name/icon/URLs in `external`, the API
 *                 key and webhook endpoints created for it).
 * dropship_order_refs  an order pushed to a dropshipping provider and its
 *                 number there (modules/dropship).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('NOW()');
    const id = { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') };
    const stamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    };
    const workspace = { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' };

    await queryInterface.createTable('apps', {
      id,
      key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      category: { type: DataTypes.STRING(40), allowNull: false },
      kind: { type: DataTypes.STRING(20), allowNull: false }, // feature | integration
      price_amount: { type: DataTypes.BIGINT, allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      billing: { type: DataTypes.STRING(20), allowNull: true }, // once | monthly
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...stamps,
    });

    await queryInterface.createTable('workspace_apps', {
      id,
      workspace_id: workspace,
      kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'catalogue' }, // catalogue | external
      app_key: { type: DataTypes.STRING(60), allowNull: true },
      external: { type: DataTypes.JSONB, allowNull: true },
      api_key_id: { type: DataTypes.UUID, allowNull: true },
      webhook_endpoint_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'installed' }, // installed | uninstalled
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      installed_by_user_id: { type: DataTypes.UUID, allowNull: true },
      installed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      uninstalled_at: { type: DataTypes.DATE, allowNull: true },
      renews_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps,
    });
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX workspace_apps_key_uq ON workspace_apps (workspace_id, app_key) WHERE app_key IS NOT NULL'
    );
    await queryInterface.addIndex('workspace_apps', ['workspace_id', 'status'], { name: 'workspace_apps_status_idx' });

    await queryInterface.createTable('dropship_order_refs', {
      id,
      workspace_id: workspace,
      order_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      external_order_id: { type: DataTypes.STRING(120), allowNull: false },
      external_status: { type: DataTypes.STRING(60), allowNull: true },
      pushed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      ...stamps,
    });
    await queryInterface.addIndex('dropship_order_refs', ['workspace_id', 'order_id', 'provider'], {
      unique: true,
      name: 'dropship_order_refs_uq',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('dropship_order_refs');
    await queryInterface.dropTable('workspace_apps');
    await queryInterface.dropTable('apps');
  },
};
