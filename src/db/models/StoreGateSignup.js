'use strict';

module.exports = (sequelize, DataTypes) => {
  // An email left on a locked / coming-soon store (migration 469, modules/storeGate).
  const StoreGateSignup = sequelize.define(
    'StoreGateSignup',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      email: { type: DataTypes.STRING(255), allowNull: false },
      locale: { type: DataTypes.STRING(5), allowNull: true },
      notifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'notified_at' },
      requestIp: { type: DataTypes.STRING(45), allowNull: true, field: 'request_ip' },
    },
    { tableName: 'store_gate_signups' }
  );
  return StoreGateSignup;
};
