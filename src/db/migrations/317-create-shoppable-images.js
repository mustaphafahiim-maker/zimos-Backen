'use strict';

/**
 * Shoppable images (SPEC §7.9): one picture with clickable points, each
 * linked to a product. `hotspots` is [{ x, y, productId }] with x and y as
 * percentages of the image's width and height.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    await queryInterface.createTable('shoppable_images', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false },
      image_url: { type: DataTypes.STRING(1000), allowNull: false },
      hotspots: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('shoppable_images', ['workspace_id', 'slug'], { unique: true, name: 'shoppable_images_ws_slug_uq' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('shoppable_images');
  },
};
