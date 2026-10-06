'use strict';

module.exports = (sequelize, DataTypes) => {
  // A shopper's request for a quote and the store's offer (migration 485, modules/quotes).
  const QuoteRequest = sequelize.define(
    'QuoteRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      number: { type: DataTypes.STRING(20), allowNull: false },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      contact: { type: DataTypes.JSONB, allowNull: false },
      lines: { type: DataTypes.JSONB, allowNull: false },
      message: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'new' },
      quotedLines: { type: DataTypes.JSONB, allowNull: true, field: 'quoted_lines' },
      quotedNote: { type: DataTypes.TEXT, allowNull: true, field: 'quoted_note' },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      validUntil: { type: DataTypes.DATE, allowNull: true, field: 'valid_until' },
      quotedAt: { type: DataTypes.DATE, allowNull: true, field: 'quoted_at' },
      quotedBy: { type: DataTypes.UUID, allowNull: true, field: 'quoted_by' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'token_hash' },
      requestIp: { type: DataTypes.STRING(45), allowNull: true, field: 'request_ip' },
    },
    { tableName: 'quote_requests' }
  );
  return QuoteRequest;
};
