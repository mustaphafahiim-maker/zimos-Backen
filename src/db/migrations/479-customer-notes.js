'use strict';

/**
 * Notes and follow-ups on customers (modules/customerNotes, spec-gaps item 209).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const ts = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    };
    await queryInterface.createTable('customer_notes', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      author_user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      body: { type: Sequelize.TEXT, allowNull: false },
      is_pinned: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      ...ts,
    });
    await queryInterface.addIndex('customer_notes', ['customer_id', 'created_at'], { name: 'customer_notes_customer_idx' });
    await queryInterface.createTable('customer_followups', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      assignee_user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      created_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      title: { type: Sequelize.STRING(200), allowNull: false },
      due_at: { type: Sequelize.DATE, allowNull: false },
      done_at: { type: Sequelize.DATE, allowNull: true },
      notified_at: { type: Sequelize.DATE, allowNull: true },
      ...ts,
    });
    await queryInterface.addIndex('customer_followups', ['workspace_id', 'done_at', 'due_at'], { name: 'customer_followups_due_idx' });
    await queryInterface.addIndex('customer_followups', ['customer_id'], { name: 'customer_followups_customer_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('customer_followups');
    await queryInterface.dropTable('customer_notes');
  },
};
