'use strict';

module.exports = (sequelize, DataTypes) => {
  // One AI generation request (migration 203) — see modules/ai/aiService.js.
  const AiJob = sequelize.define(
    'AiJob',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
      feature: { type: DataTypes.STRING(40), allowNull: false },
      // 'queued' | 'running' | 'succeeded' | 'failed'
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      input: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      output: { type: DataTypes.JSONB, allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      provider: { type: DataTypes.STRING(40), allowNull: true },
      promptVersion: { type: DataTypes.STRING(60), allowNull: true, field: 'prompt_version' },
      applied: { type: DataTypes.JSONB, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    },
    { tableName: 'ai_jobs', indexes: [{ fields: ['workspace_id', 'created_at'], name: 'ai_jobs_ws_created_idx' }] }
  );
  return AiJob;
};
