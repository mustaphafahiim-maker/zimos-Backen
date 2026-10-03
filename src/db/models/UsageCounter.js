'use strict';

module.exports = (sequelize, DataTypes) => {
  // What a store used in one calendar month (billing/usageCounters.js).
  const UsageCounter = sequelize.define(
    'UsageCounter',
    {
      workspaceId: { type: DataTypes.UUID, primaryKey: true, field: 'workspace_id' },
      period: { type: DataTypes.STRING(7), primaryKey: true },
      orders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      messages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      aiRequests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'ai_requests' },
      storageBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'storage_bytes' },
    },
    { tableName: 'usage_counters' }
  );
  return UsageCounter;
};
