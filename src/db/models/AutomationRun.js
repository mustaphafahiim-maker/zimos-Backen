'use strict';

module.exports = (sequelize, DataTypes) => {
  const AutomationRun = sequelize.define(
    'AutomationRun',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      ruleId: { type: DataTypes.UUID, allowNull: true, field: 'rule_id' },
      trigger: { type: DataTypes.STRING(100), allowNull: false },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      // sent | skipped | failed
      status: { type: DataTypes.STRING(20), allowNull: false },
      detail: { type: DataTypes.STRING(500), allowNull: true },
    },
    { tableName: 'automation_runs', updatedAt: false, indexes: [{ fields: ['workspace_id', 'created_at'] }] }
  );
  return AutomationRun;
};
