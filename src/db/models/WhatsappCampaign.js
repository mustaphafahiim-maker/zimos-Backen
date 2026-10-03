'use strict';

module.exports = (sequelize, DataTypes) => {
  // A WhatsApp broadcast to consenting contacts (modules/whatsapp/campaignService.js).
  const WhatsappCampaign = sequelize.define(
    'WhatsappCampaign',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(150), allowNull: false },
      // draft | scheduled | sending | paused | completed | cancelled
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      templateName: { type: DataTypes.STRING(200), allowNull: false, field: 'template_name' },
      templateLanguage: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ar', field: 'template_language' },
      templateParams: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'template_params' },
      couponCode: { type: DataTypes.STRING(100), allowNull: true, field: 'coupon_code' },
      dailyCap: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 250, field: 'daily_cap' },
      scheduledAt: { type: DataTypes.DATE, allowNull: true, field: 'scheduled_at' },
      startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      pauseReason: { type: DataTypes.STRING(300), allowNull: true, field: 'pause_reason' },
      audienceSize: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'audience_size' },
      excludedNoConsent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'excluded_no_consent' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'whatsapp_campaigns', indexes: [{ fields: ['workspace_id', 'created_at'] }] }
  );
  return WhatsappCampaign;
};
