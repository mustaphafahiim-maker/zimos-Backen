'use strict';

module.exports = (sequelize, DataTypes) => {
  // One accepted funnel offer (upsell/downsell step) for one order — unique on
  // (order_id, step_key), which is what makes accepting idempotent. `result`:
  // 'merged' into the order (orderItemId) or 'separate', a linked order of its
  // own (followOnOrderId). See modules/funnels/funnelOfferMerge.js.
  const FunnelOfferAcceptance = sequelize.define(
    'FunnelOfferAcceptance',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      sessionId: { type: DataTypes.UUID, allowNull: true, field: 'session_id' },
      stepKey: { type: DataTypes.STRING(100), allowNull: false, field: 'step_key' },
      offerId: { type: DataTypes.UUID, allowNull: true, field: 'offer_id' },
      result: { type: DataTypes.STRING(16), allowNull: false },
      orderItemId: { type: DataTypes.UUID, allowNull: true, field: 'order_item_id' },
      followOnOrderId: { type: DataTypes.UUID, allowNull: true, field: 'follow_on_order_id' },
    },
    { tableName: 'funnel_offer_acceptances', indexes: [{ unique: true, fields: ['order_id', 'step_key'] }] }
  );
  FunnelOfferAcceptance.associate = (models) => {
    FunnelOfferAcceptance.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    FunnelOfferAcceptance.belongsTo(models.Order, { foreignKey: 'followOnOrderId', as: 'followOnOrder' });
  };
  return FunnelOfferAcceptance;
};
