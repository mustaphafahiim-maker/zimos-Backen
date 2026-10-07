'use strict';

module.exports = (sequelize, DataTypes) => {
  const CodSettlement = sequelize.define(
    'CodSettlement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      carrierCode: { type: DataTypes.STRING(100), allowNull: false, field: 'carrier_code' },
      // One of the store's own couriers (migration 216); null = a shipping company or a typed name.
      courierId: { type: DataTypes.UUID, allowNull: true, field: 'courier_id' },
      reference: { type: DataTypes.STRING(120), allowNull: true },
      periodStart: { type: DataTypes.DATEONLY, allowNull: true, field: 'period_start' },
      periodEnd: { type: DataTypes.DATEONLY, allowNull: true, field: 'period_end' },
      // draft | confirmed
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      collectedAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'collected_amount' },
      feesAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'fees_amount' },
      netAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'net_amount' },
      notes: { type: DataTypes.STRING(1000), allowNull: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
      confirmedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'confirmed_by_user_id' },
      confirmedAt: { type: DataTypes.DATE, allowNull: true, field: 'confirmed_at' },
      // Result of matching a courier statement (settlementStatementService), when created from one.
      statementReport: { type: DataTypes.JSONB, allowNull: true, field: 'statement_report' },
    },
    { tableName: 'cod_settlements', indexes: [{ fields: ['workspace_id', 'status'] }] }
  );
  CodSettlement.associate = (models) => {
    CodSettlement.hasMany(models.CodSettlementLine, { foreignKey: 'settlementId', as: 'lines' });
  };
  return CodSettlement;
};
