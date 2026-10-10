'use strict';

const { guarded } = require('../migrationGuards');

/**
 * AI module (SPEC §19).
 *
 *   ai_jobs   one generation request: its input, its validated output and
 *             what was made from it. The dashboard polls it.
 *   ai_usage  one row per finished request (type, tokens, cost) — the
 *             usage counter and its ledger.
 *
 * Nothing writes here while AI_ENABLED is off (modules/ai).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false };
    const workspace = { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' };

    await queryInterface.createTable('ai_jobs', {
      id,
      workspace_id: workspace,
      user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      feature: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      input: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      output: { type: DataTypes.JSONB, allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      provider: { type: DataTypes.STRING(40), allowNull: true },
      prompt_version: { type: DataTypes.STRING(60), allowNull: true },
      // What "Apply" created from the output: { type: 'product' | 'page', id }.
      applied: { type: DataTypes.JSONB, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addConstraint('ai_jobs', {
      type: 'check',
      name: 'ai_jobs_status_check',
      fields: ['status'],
      where: { status: ['queued', 'running', 'succeeded', 'failed'] },
    });
    await queryInterface.addIndex('ai_jobs', ['workspace_id', 'created_at'], { name: 'ai_jobs_ws_created_idx' });

    await queryInterface.createTable('ai_usage', {
      id,
      workspace_id: workspace,
      job_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'ai_jobs', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      type: { type: DataTypes.STRING(40), allowNull: false },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      tokens_in: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      tokens_out: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // What the provider reported the request cost, in micro-units of
      // `cost_currency` (the provider's, not the store's). 0 on the sandbox.
      cost_micros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      cost_currency: { type: DataTypes.STRING(3), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('ai_usage', ['workspace_id', 'created_at'], { name: 'ai_usage_ws_created_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('ai_usage');
    await queryInterface.dropTable('ai_jobs');
  },
};
