'use strict';

module.exports = (sequelize, DataTypes) => {
  // A phone or an email address that asked the store to stop marketing messages
  // (migrations 178 and 201, whatsapp/optOut.js, notifications/marketingUnsubscribe.js).
  const MarketingOptOut = sequelize.define(
    'MarketingOptOut',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: true, field: 'phone_normalized' },
      email: { type: DataTypes.STRING(255), allowNull: true },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'whatsapp' },
      word: { type: DataTypes.STRING(40), allowNull: true },
    },
    { tableName: 'marketing_opt_outs', indexes: [{ unique: true, fields: ['workspace_id', 'phone_normalized'], name: 'marketing_opt_outs_ws_phone_uq' }] }
  );
  return MarketingOptOut;
};
