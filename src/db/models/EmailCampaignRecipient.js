'use strict';

module.exports = (sequelize, DataTypes) => {
  // One address a campaign goes to (migration 472, modules/emailCampaigns).
  const EmailCampaignRecipient = sequelize.define(
    'EmailCampaignRecipient',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaignId: { type: DataTypes.UUID, allowNull: false, field: 'campaign_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      email: { type: DataTypes.STRING(255), allowNull: false },
      fullName: { type: DataTypes.STRING(200), allowNull: true, field: 'full_name' },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'queued' },
      error: { type: DataTypes.STRING(300), allowNull: true },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      openedAt: { type: DataTypes.DATE, allowNull: true, field: 'opened_at' },
    },
    { tableName: 'email_campaign_recipients' }
  );
  return EmailCampaignRecipient;
};
