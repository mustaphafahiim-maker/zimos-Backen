'use strict';

module.exports = (sequelize, DataTypes) => {
  // A domain bought from the dashboard (migration 457, modules/domains/purchases.js).
  const DomainPurchase = sequelize.define(
    'DomainPurchase',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      domainId: { type: DataTypes.UUID, allowNull: true, field: 'domain_id' },
      hostname: { type: DataTypes.STRING(255), allowNull: false },
      registrar: { type: DataTypes.STRING(40), allowNull: false },
      providerRef: { type: DataTypes.STRING(120), allowNull: true, field: 'provider_ref' },
      // pending | active | failed | expired
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      years: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // As the registrar quoted it at purchase; null when it gave none.
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount', get() { const v = this.getDataValue('priceAmount'); return v === null || v === undefined ? null : Number(v); } },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      autoRenew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'auto_renew' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      lastRenewedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_renewed_at' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'domain_purchases' }
  );
  return DomainPurchase;
};
