'use strict';

module.exports = (sequelize, DataTypes) => {
  const ReturnRequest = sequelize.define(
    'ReturnRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      reason: { type: DataTypes.STRING(300), allowNull: false },
      status: {
        type: DataTypes.ENUM('requested', 'approved', 'rejected', 'received', 'refunded'),
        allowNull: false,
        defaultValue: 'requested',
      },
      items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ orderItemId, quantity }]
      // Restocking is an explicit separate action (see returnService.restock),
      // never automatic on refund/approval.
      restockedAt: { type: DataTypes.DATE, allowNull: true, field: 'restocked_at' },
      // merchant | shopper (migration 462): a shopper opens one from the tracking page (shopperReturns.js).
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'merchant' },
      photoUploadIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'photo_upload_ids' },
      // Migration 507 (item 372): refund | exchange (each item line then names its exchangeVariantId),
      // the replacement order, the merchant's answer, and the courier booked to collect the parcel.
      resolution: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'refund' },
      exchangeOrderId: { type: DataTypes.UUID, allowNull: true, field: 'exchange_order_id' },
      decisionNote: { type: DataTypes.STRING(500), allowNull: true, field: 'decision_note' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      pickup: { type: DataTypes.JSONB, allowNull: true },
    },
    { tableName: 'return_requests', indexes: [{ fields: ['workspace_id'] }, { fields: ['order_id'] }] }
  );
  ReturnRequest.associate = (models) => {
    ReturnRequest.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return ReturnRequest;
};
