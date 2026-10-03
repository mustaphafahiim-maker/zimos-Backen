'use strict';

/**
 * workspace_custom_code: the merchant's own HTML/CSS/JS for the fixed slots
 * of their store (SPEC §8.4) — one row per (workspace, slot). Kept outside
 * the page tree on purpose: the page builder refuses raw HTML, and this is
 * the one audited place where a store may carry code of its own
 * (modules/customCode).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('workspace_custom_code', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
      },
      slot: { type: DataTypes.STRING(40), allowNull: false },
      html: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      updated_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('workspace_custom_code', ['workspace_id', 'slot'], {
      unique: true,
      name: 'workspace_custom_code_workspace_slot_uq',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('workspace_custom_code');
  },
};
