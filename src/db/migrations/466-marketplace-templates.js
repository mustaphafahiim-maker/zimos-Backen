'use strict';

/**
 * The template marketplace (modules/marketplace, spec-gaps item 192): a
 * merchant submits one of their funnels; the platform reviews it; approved
 * ones are listed for every store to copy. `snapshot` is the funnel as it was
 * submitted (steps and links, products taken out), so later edits to the
 * source funnel never change what others get. Free only: no price here.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('marketplace_templates', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      funnel_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'funnels', key: 'id' }, onDelete: 'SET NULL' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.STRING(1000), allowNull: true },
      category: { type: Sequelize.STRING(40), allowNull: false },
      tags: { type: Sequelize.ARRAY(Sequelize.STRING(40)), allowNull: false, defaultValue: [] },
      thumbnail_url: { type: Sequelize.STRING(1000), allowNull: true },
      author_name: { type: Sequelize.STRING(120), allowNull: false },
      language: { type: Sequelize.STRING(5), allowNull: true },
      snapshot: { type: Sequelize.JSONB, allowNull: false },
      step_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
      review_note: { type: Sequelize.STRING(1000), allowNull: true },
      reviewed_by: { type: Sequelize.UUID, allowNull: true },
      reviewed_at: { type: Sequelize.DATE, allowNull: true },
      uses_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      submitted_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('marketplace_templates', ['status', 'category'], { name: 'marketplace_templates_status_idx' });
    await queryInterface.addIndex('marketplace_templates', ['workspace_id'], { name: 'marketplace_templates_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('marketplace_templates');
  },
};
