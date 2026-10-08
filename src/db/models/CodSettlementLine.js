'use strict';

module.exports = (sequelize, DataTypes) => {
  const CodSettlementLine = sequelize.define(
    'CodSettlementLine',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      settlementId: { type: DataTypes.UUID, allowNull: false, field: 'settlement_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      shipmentId: { type: DataTypes.UUID, allowNull: true, field: 'shipment_id' },
      collectedAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'collected_amount' },
      feeAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'fee_amount' },
    },
    { tableName: 'cod_settlement_lines', indexes: [{ unique: true, fields: ['workspace_id', 'order_id', 'shipment_id'] }] }
  );
  CodSettlementLine.associate = (models) => {
    CodSettlementLine.belongsTo(models.CodSettlement, { foreignKey: 'settlementId', as: 'settlement' });
    CodSettlementLine.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return CodSettlementLine;
};
