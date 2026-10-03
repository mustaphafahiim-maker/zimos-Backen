'use strict';

module.exports = (sequelize, DataTypes) => {
  // A marketer who sells the store's products for a commission (migration 314).
  const Affiliate = sequelize.define(
    'Affiliate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      // The `?ref=` value of their links. Unique per store, case-insensitive.
      code: { type: DataTypes.STRING(40), allowNull: false },
      // 'percent' (basis points) | 'fixed' (minor units per order)
      commissionType: { type: DataTypes.STRING(10), allowNull: false, field: 'commission_type' },
      commissionValue: { type: DataTypes.BIGINT, allowNull: false, field: 'commission_value' },
      productIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'product_ids' },
      // 'active' | 'paused'
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
      notes: { type: DataTypes.STRING(500), allowNull: true },
    },
    { tableName: 'affiliates', indexes: [{ unique: true, fields: ['workspace_id', 'phone_normalized'], name: 'affiliates_ws_phone_uq' }] }
  );
  return Affiliate;
};
