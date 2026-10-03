'use strict';

module.exports = (sequelize, DataTypes) => {
  const Experiment = sequelize.define(
    'Experiment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subjectType: { type: DataTypes.ENUM('website_page', 'funnel_step'), allowNull: false, field: 'subject_type' },
      subjectId: { type: DataTypes.UUID, allowNull: false, field: 'subject_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      // [{ key: 'A', weight: 50, data: {...} }, { key: 'B', weight: 50, data: {...} }]
      variants: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      status: { type: DataTypes.ENUM('running', 'paused', 'completed'), allowNull: false, defaultValue: 'running' },
      // Split tests on a funnel step (modules/funnels/splitTests.js).
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      stepKey: { type: DataTypes.STRING(100), allowNull: true, field: 'step_key' },
      autoWinner: { type: DataTypes.JSONB, allowNull: true, field: 'auto_winner' },
      winnerVariantKey: { type: DataTypes.STRING(50), allowNull: true, field: 'winner_variant_key' },
    },
    { tableName: 'experiments', indexes: [{ fields: ['workspace_id', 'subject_type', 'subject_id'] }] }
  );
  return Experiment;
};
