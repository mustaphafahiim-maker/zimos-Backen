'use strict';

module.exports = (sequelize, DataTypes) => {
  // A customer's request for a copy of their data or to be erased (migration 497, modules/privacyRequests).
  const PrivacyRequest = sequelize.define(
    'PrivacyRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      kind: { type: DataTypes.STRING(8), allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      requesterLabel: { type: DataTypes.STRING(120), allowNull: true, field: 'requester_label' },
      reason: { type: DataTypes.STRING(500), allowNull: true },
      decisionNote: { type: DataTypes.STRING(500), allowNull: true, field: 'decision_note' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      completedBy: { type: DataTypes.UUID, allowNull: true, field: 'completed_by' },
    },
    { tableName: 'privacy_requests' }
  );
  return PrivacyRequest;
};
