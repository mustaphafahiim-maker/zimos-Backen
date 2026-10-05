'use strict';

const { guarded } = require('../migrationGuards');

/**
 * saved_sections: a section of a page the merchant saved to use again
 * (SPEC §9.3 "smart sections"). `scope = 'global'` is offered on every page of
 * the store and in every funnel; `scope = 'funnel'` only inside `funnel_id`.
 * `tree` is one page-tree section node (modules/pages/pageTree.js), `type` a
 * free label for the library ("hero", "footer", …).
 *
 * A page section that carries `settings.savedSectionId` is a linked copy: when
 * the website is published its content is taken from this row, so editing the
 * saved section once changes every copy (modules/savedSections).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('saved_sections', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
      },
      scope: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'global' },
      funnel_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: { type: DataTypes.STRING(120), allowNull: false },
      type: { type: DataTypes.STRING(40), allowNull: true },
      tree: { type: DataTypes.JSONB, allowNull: false },
      created_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('saved_sections', ['workspace_id', 'scope'], { name: 'saved_sections_workspace_scope_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('saved_sections');
  },
};
