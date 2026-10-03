'use strict';

module.exports = (sequelize, DataTypes) => {
  // A phone that asked the store to stop marketing messages (migration 400, whatsapp/optOut.js).
  const MarketingOptOut = sequelize.define(
    'MarketingOptOut',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'whatsapp' },
      word: { type: DataTypes.STRING(40), allowNull: true },
    },
    { tableName: 'marketing_opt_outs', indexes: [{ unique: true, fields: ['workspace_id', 'phone_normalized'], name: 'marketing_opt_outs_ws_phone_uq' }] }
  );
  return MarketingOptOut;
};
