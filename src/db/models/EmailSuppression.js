'use strict';

module.exports = (sequelize, DataTypes) => {
  // An address no email goes to any more (migration 660, notifications/deliveryStatus): it hard-bounced or its owner
  // marked an email as spam. Per store (workspaceId) or for the platform's own emails (null).
  // Not a marketing opt-out (MarketingOptOut): this stops every email, transactional ones too.
  const EmailSuppression = sequelize.define(
    'EmailSuppression',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      email: { type: DataTypes.STRING(255), allowNull: false },
      // hard_bounce | complaint
      reason: { type: DataTypes.STRING(20), allowNull: false },
      // The provider that reported it: brevo | console
      source: { type: DataTypes.STRING(30), allowNull: false },
      detail: { type: DataTypes.STRING(300), allowNull: true },
      notificationLogId: { type: DataTypes.UUID, allowNull: true, field: 'notification_log_id' },
    },
    { tableName: 'email_suppressions', updatedAt: false }
  );
  return EmailSuppression;
};
