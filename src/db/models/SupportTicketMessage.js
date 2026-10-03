'use strict';

module.exports = (sequelize, DataTypes) => {
  // One message in a support ticket's thread — see migration 104.
  const SupportTicketMessage = sequelize.define(
    'SupportTicketMessage',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      ticketId: { type: DataTypes.UUID, allowNull: false, field: 'ticket_id' },
      authorUserId: { type: DataTypes.UUID, allowNull: true, field: 'author_user_id' },
      // 'merchant' | 'admin' (CHECK constraint).
      authorType: { type: DataTypes.STRING(10), allowNull: false, field: 'author_type' },
      body: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'support_ticket_messages', indexes: [{ fields: ['ticket_id', 'created_at'] }] }
  );

  SupportTicketMessage.associate = (models) => {
    SupportTicketMessage.belongsTo(models.SupportTicket, { foreignKey: 'ticketId', as: 'ticket' });
    SupportTicketMessage.belongsTo(models.User, { foreignKey: 'authorUserId', as: 'author' });
  };

  return SupportTicketMessage;
};
