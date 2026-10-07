'use strict';

module.exports = (sequelize, DataTypes) => {
  // A shopper's answers to the post-purchase survey (migration 498, modules/postPurchaseSurvey).
  const SurveyResponse = sequelize.define(
    'SurveyResponse',
    {
      orderId: { type: DataTypes.UUID, primaryKey: true, field: 'order_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      answers: { type: DataTypes.JSONB, allowNull: false },
    },
    { tableName: 'survey_responses' }
  );
  return SurveyResponse;
};
