'use strict';

/**
 * Digital products (SPEC §18.2).
 *
 *   digital_files       the file library: private files a product can deliver.
 *   digital_deliveries  how one digital product is delivered: a file, a link,
 *                       or a licence code drawn from stock.
 *   license_codes       the code stock of a product; a code is given once.
 *   digital_grants      what one paid order line gave its buyer: the download
 *                       token, the codes, the download count and the expiry.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false };
    const ref = (model, onDelete = 'CASCADE', allowNull = false) => ({
      type: DataTypes.UUID,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('digital_files', {
      id,
      workspace_id: ref('workspaces'),
      name: { type: DataTypes.STRING(300), allowNull: false },
      storage_key: { type: DataTypes.STRING(500), allowNull: false },
      mime_type: { type: DataTypes.STRING(150), allowNull: false },
      size_bytes: { type: DataTypes.BIGINT, allowNull: false },
      uploaded_by: ref('users', 'SET NULL', true),
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('digital_files', ['workspace_id', 'created_at'], { name: 'digital_files_ws_created_idx' });

    await queryInterface.createTable('digital_deliveries', {
      id,
      workspace_id: ref('workspaces'),
      product_id: ref('products'),
      type: { type: DataTypes.STRING(20), allowNull: false },
      file_id: ref('digital_files', 'RESTRICT', true),
      link_url: { type: DataTypes.STRING(1000), allowNull: true },
      message: { type: DataTypes.TEXT, allowNull: true },
      max_downloads: { type: DataTypes.INTEGER, allowNull: true },
      link_valid_hours: { type: DataTypes.INTEGER, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE digital_deliveries ADD CONSTRAINT digital_deliveries_type_check CHECK (type IN ('file', 'link', 'license_codes'))`
    );
    await queryInterface.addIndex('digital_deliveries', ['product_id'], { unique: true, name: 'digital_deliveries_product_uq' });
    await queryInterface.addIndex('digital_deliveries', ['workspace_id'], { name: 'digital_deliveries_ws_idx' });

    await queryInterface.createTable('digital_grants', {
      id,
      workspace_id: ref('workspaces'),
      order_id: ref('orders'),
      order_item_id: ref('order_items'),
      product_id: ref('products', 'SET NULL', true),
      product_name: { type: DataTypes.STRING(300), allowNull: false },
      type: { type: DataTypes.STRING(20), allowNull: false },
      file_id: ref('digital_files', 'SET NULL', true),
      link_url: { type: DataTypes.STRING(1000), allowNull: true },
      message: { type: DataTypes.TEXT, allowNull: true },
      codes: { type: DataTypes.ARRAY(DataTypes.STRING(200)), allowNull: false, defaultValue: [] },
      // How many codes the line was owed but the stock could not give.
      codes_missing: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      token: { type: DataTypes.STRING(64), allowNull: false },
      max_downloads: { type: DataTypes.INTEGER, allowNull: true },
      download_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_downloaded_at: { type: DataTypes.DATE, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('digital_grants', ['token'], { unique: true, name: 'digital_grants_token_uq' });
    await queryInterface.addIndex('digital_grants', ['order_item_id'], { unique: true, name: 'digital_grants_order_item_uq' });
    await queryInterface.addIndex('digital_grants', ['workspace_id', 'order_id'], { name: 'digital_grants_ws_order_idx' });

    await queryInterface.createTable('license_codes', {
      id,
      workspace_id: ref('workspaces'),
      product_id: ref('products'),
      code: { type: DataTypes.STRING(200), allowNull: false },
      grant_id: ref('digital_grants', 'SET NULL', true),
      assigned_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('license_codes', ['product_id', 'code'], { unique: true, name: 'license_codes_product_code_uq' });
    await queryInterface.addIndex('license_codes', ['product_id', 'assigned_at', 'created_at'], { name: 'license_codes_stock_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('license_codes');
    await queryInterface.dropTable('digital_grants');
    await queryInterface.dropTable('digital_deliveries');
    await queryInterface.dropTable('digital_files');
  },
};
