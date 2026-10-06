'use strict';

/**
 * digital_uploads (SPEC §18.2 "upload large files via multipart upload
 * directly to storage"): a library file the browser is uploading in parts
 * straight to private storage (digital/multipartUploads.js). It becomes a
 * digital_files row when completed; an abandoned one is aborted and removed
 * after a day.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('digital_uploads', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      // The storage provider's own id for the multipart upload.
      upload_id: { type: DataTypes.STRING(1024), allowNull: false },
      storage_key: { type: DataTypes.STRING(500), allowNull: false },
      name: { type: DataTypes.STRING(300), allowNull: false },
      mime_type: { type: DataTypes.STRING(150), allowNull: false },
      size_bytes: { type: DataTypes.BIGINT, allowNull: false },
      part_size: { type: DataTypes.INTEGER, allowNull: false },
      part_count: { type: DataTypes.INTEGER, allowNull: false },
      uploaded_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('digital_uploads', ['workspace_id', 'created_at'], { name: 'digital_uploads_ws_created_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('digital_uploads');
  },
};
