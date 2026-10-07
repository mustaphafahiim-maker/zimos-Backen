'use strict';

/** Post-purchase survey answers, one per order (modules/postPurchaseSurvey, spec-gaps item 236). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('survey_responses', {
      order_id: { type: Sequelize.UUID, primaryKey: true, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      // { [questionId]: optionId | score 0–10 | text }
      answers: { type: Sequelize.JSONB, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('survey_responses', ['workspace_id', 'created_at'], { name: 'survey_responses_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('survey_responses');
  },
};
