'use strict';

module.exports = (sequelize, DataTypes) => {
  // One licence code in a product's stock (migration 312). Given once: a row
  // with `assignedAt` set belongs to the grant in `grantId` for good.
  const LicenseCode = sequelize.define(
    'LicenseCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      code: { type: DataTypes.STRING(200), allowNull: false },
      grantId: { type: DataTypes.UUID, allowNull: true, field: 'grant_id' },
      assignedAt: { type: DataTypes.DATE, allowNull: true, field: 'assigned_at' },
    },
    { tableName: 'license_codes', indexes: [{ unique: true, fields: ['product_id', 'code'], name: 'license_codes_product_code_uq' }] }
  );
  return LicenseCode;
};
