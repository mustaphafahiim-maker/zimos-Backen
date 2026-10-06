'use strict';

module.exports = (sequelize, DataTypes) => {
  // A broadcast email to consenting contacts (migration 472, modules/emailCampaigns).
  const EmailCampaign = sequelize.define(
    'EmailCampaign',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      subject: { type: DataTypes.STRING(200), allowNull: false },
      blocks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'draft' },
      scheduledAt: { type: DataTypes.DATE, allowNull: true, field: 'scheduled_at' },
      startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'email_campaigns' }
  );
  return EmailCampaign;
};
