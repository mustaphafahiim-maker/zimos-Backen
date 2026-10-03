'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant's conversation with the platform team — see migration 104 for
  // what each status means, and modules/support for who may move it where.
  const SupportTicket = sequelize.define(
    'SupportTicket',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
      subject: { type: DataTypes.STRING(200), allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'general' },
      // 'open' | 'pending' | 'resolved' | 'closed' (CHECK constraint).
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
      // 'low' | 'normal' | 'high' | 'urgent' (CHECK constraint).
      priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'normal' },
      lastMessageAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'last_message_at' },
      // 'merchant' | 'admin' — who spoke last.
      lastMessageBy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'merchant', field: 'last_message_by' },
    },
    {
      tableName: 'support_tickets',
      indexes: [{ fields: ['workspace_id', 'created_at'] }, { fields: ['status', 'last_message_at'] }],
    }
  );

  SupportTicket.associate = (models) => {
    SupportTicket.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    SupportTicket.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
    SupportTicket.hasMany(models.SupportTicketMessage, { foreignKey: 'ticketId', as: 'messages' });
  };

  return SupportTicket;
};
