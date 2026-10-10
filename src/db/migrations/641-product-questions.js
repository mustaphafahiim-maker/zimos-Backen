'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Product questions and answers (modules/productQuestions, STORE_FEATURES
 * product_questions). A new table, skipped when present; status is
 * VARCHAR + CHECK.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const created = await qi.createTable('product_questions', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      question: { type: Sequelize.TEXT, allowNull: false },
      asker_name: { type: Sequelize.STRING(120), allowNull: true },
      // Private: only to tell the asker their question was answered.
      asker_email: { type: Sequelize.STRING(255), allowNull: true },
      locale: { type: Sequelize.STRING(5), allowNull: true },
      answer: { type: Sequelize.TEXT, allowNull: true },
      answered_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      answered_at: { type: Sequelize.DATE, allowNull: true },
      // pending | published | hidden
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'pending' },
      request_ip: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (created) {
      await queryInterface.sequelize.query("ALTER TABLE product_questions ADD CONSTRAINT product_questions_status_check CHECK (status IN ('pending', 'published', 'hidden'))");
    }
    await qi.addIndex('product_questions', ['product_id', 'status', 'created_at'], { name: 'product_questions_product_idx' });
    await qi.addIndex('product_questions', ['workspace_id', 'status', 'created_at'], { name: 'product_questions_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('product_questions');
  },
};
