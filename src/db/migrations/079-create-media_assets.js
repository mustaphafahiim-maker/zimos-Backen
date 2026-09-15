'use strict';

/**
 * Library of images uploaded through POST /workspaces/:id/media, so the
 * merchant dashboard can list and reuse them (previously uploads were only
 * returned once and never recorded).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('media_assets', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      uploaded_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      url: { type: DataTypes.STRING(1000), allowNull: false },
      path: { type: DataTypes.STRING(500), allowNull: false },
      mime_type: { type: DataTypes.STRING(50), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('media_assets', ['workspace_id', 'created_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('media_assets');
  },
};
