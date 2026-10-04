'use strict';

/**
 * Files a teammate asked for that are built in the background (SPEC §4.3:
 * "the export runs in the `io` queue and the result is a download link in
 * notifications + email"). The bytes live in private storage under
 * `storage_path`, never in a public bucket; the row says who asked, for
 * what, and until when the link works.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('export_files', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      // Who asked: the only one who sees and downloads it.
      user_id: { type: DataTypes.UUID, allowNull: false },
      // What was exported: 'orders' for now.
      kind: { type: DataTypes.STRING(40), allowNull: false },
      format: { type: DataTypes.STRING(10), allowNull: false },
      // The filters, columns and options the file was built from.
      params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // queued | running | done | failed | expired
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      file_name: { type: DataTypes.STRING(200), allowNull: true },
      content_type: { type: DataTypes.STRING(120), allowNull: true },
      storage_path: { type: DataTypes.STRING(500), allowNull: true },
      size_bytes: { type: DataTypes.BIGINT, allowNull: true },
      error_message: { type: DataTypes.STRING(500), allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('export_files', ['workspace_id', 'user_id', 'created_at'], { name: 'export_files_owner_idx' });
    await queryInterface.addIndex('export_files', ['status', 'expires_at'], { name: 'export_files_expiry_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('export_files');
  },
};
