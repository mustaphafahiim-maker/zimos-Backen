'use strict';

module.exports = (sequelize, DataTypes) => {
  // One person of one campaign; the list is fixed when the campaign starts.
  const WhatsappCampaignRecipient = sequelize.define(
    'WhatsappCampaignRecipient',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaignId: { type: DataTypes.UUID, allowNull: false, field: 'campaign_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      name: { type: DataTypes.STRING(200), allowNull: true },
      // pending | sent | failed | skipped
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      waMessageId: { type: DataTypes.STRING(200), allowNull: true, field: 'wa_message_id' },
      error: { type: DataTypes.STRING(500), allowNull: true },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      repliedAt: { type: DataTypes.DATE, allowNull: true, field: 'replied_at' },
      unsubscribedAt: { type: DataTypes.DATE, allowNull: true, field: 'unsubscribed_at' },
    },
    { tableName: 'whatsapp_campaign_recipients', indexes: [{ unique: true, fields: ['campaign_id', 'phone_normalized'] }] }
  );
  return WhatsappCampaignRecipient;
};
