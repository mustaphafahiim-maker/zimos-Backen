'use strict';

module.exports = (sequelize, DataTypes) => {
  // One finished AI request: the usage counter and its ledger (migration 203).
  const AiUsage = sequelize.define(
    'AiUsage',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      jobId: { type: DataTypes.UUID, allowNull: true, field: 'job_id' },
      type: { type: DataTypes.STRING(40), allowNull: false },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      tokensIn: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'tokens_in' },
      tokensOut: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'tokens_out' },
      costMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'cost_micros' },
      costCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'cost_currency' },
    },
    { tableName: 'ai_usage', indexes: [{ fields: ['workspace_id', 'created_at'], name: 'ai_usage_ws_created_idx' }] }
  );
  return AiUsage;
};
