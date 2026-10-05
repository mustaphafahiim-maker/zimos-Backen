'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Step-based automations (SPEC §14.2).
 *
 * A rule's `actions` becomes an ordered sequence of steps, some of which wait.
 * One pass of a rule over one order (or lost checkout) is an *execution*: it
 * remembers the steps it started with, how far it got and what the order
 * looked like at the start, so a delayed step can stop when the order moved
 * on. Every step still writes its own automation_runs row.
 *
 *   automation_executions   one row per rule × subject run
 *   automation_runs         + execution_id, step_index, step_type
 *   automation_rules        + template_key (the ready-made template it came from)
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('automation_executions', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      rule_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'automation_rules', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      trigger: { type: DataTypes.STRING(100), allowNull: false },
      order_id: { type: DataTypes.UUID, allowNull: true },
      checkout_session_id: { type: DataTypes.UUID, allowNull: true },
      // running | waiting | completed | stopped
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'running' },
      steps: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      next_step_index: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      context: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      resume_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('automation_executions', ['workspace_id', 'status'], { name: 'automation_executions_workspace_status_idx' });
    await queryInterface.addIndex('automation_executions', ['order_id'], { name: 'automation_executions_order_idx' });

    await queryInterface.addColumn('automation_runs', 'execution_id', { type: DataTypes.UUID, allowNull: true });
    await queryInterface.addColumn('automation_runs', 'step_index', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('automation_runs', 'step_type', { type: DataTypes.STRING(30), allowNull: true });
    await queryInterface.addColumn('automation_rules', 'template_key', { type: DataTypes.STRING(60), allowNull: true });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('automation_rules', 'template_key');
    await queryInterface.removeColumn('automation_runs', 'step_type');
    await queryInterface.removeColumn('automation_runs', 'step_index');
    await queryInterface.removeColumn('automation_runs', 'execution_id');
    await queryInterface.dropTable('automation_executions');
  },
};
