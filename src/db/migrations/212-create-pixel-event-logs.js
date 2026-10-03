'use strict';

/**
 * pixel_event_logs (SPEC §13.5): what the server sent to the ad platforms —
 * one row per event per pixel, with whether the platform accepted it. The
 * dashboard shows the latest 500 per store; older rows are pruned by the
 * `pixels.prune_logs` schedule (modules/marketing/jobs.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('pixel_event_logs', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      tracking_pixel_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tracking_pixels', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      platform: { type: DataTypes.STRING(20), allowNull: false },
      pixel_id: { type: DataTypes.STRING(64), allowNull: false },
      event_name: { type: DataTypes.STRING(40), allowNull: false },
      event_id: { type: DataTypes.STRING(64), allowNull: true },
      order_id: { type: DataTypes.UUID, allowNull: true },
      status: { type: DataTypes.STRING(10), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      is_test: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('pixel_event_logs', ['workspace_id', 'created_at'], { name: 'pixel_event_logs_workspace_created_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('pixel_event_logs');
  },
};
