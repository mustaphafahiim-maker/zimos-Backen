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
      // What the merchant was charged: the registrar's quote with the platform's margin (item 325); null when it gave none.
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount', get() { const v = this.getDataValue('priceAmount'); return v === null || v === undefined ? null : Number(v); } },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      // The registrar's own price, before the platform's margin (migration 504, item 325).
      costAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'cost_amount', get() { const v = this.getDataValue('costAmount'); return v === null || v === undefined ? null : Number(v); } },
      costCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'cost_currency' },
      autoRenew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'auto_renew' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      lastRenewedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_renewed_at' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      // When the owner last unlocked it and took its transfer code (migration 522, item 385); the code is never stored.
      transferUnlockedAt: { type: DataTypes.DATE, allowNull: true, field: 'transfer_unlocked_at' },
    },
    { tableName: 'domain_purchases' }
  );
  return DomainPurchase;
};
