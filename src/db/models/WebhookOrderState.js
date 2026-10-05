'use strict';
module.exports = (sequelize, DataTypes) => {
  // The last state the webhook observer saw for one order (migration 117,
  // modules/webhooks/orderChangeDetector.js). Written only by that detector.
  const WebhookOrderState = sequelize.define(
    'WebhookOrderState',
    {
      orderId: { type: DataTypes.UUID, primaryKey: true, field: 'order_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      signature: { type: DataTypes.STRING(200), allowNull: false },
      state: { type: DataTypes.JSONB, allowNull: false },
    },
    { tableName: 'webhook_order_states', indexes: [{ fields: ['workspace_id'] }] }
  );
  return WebhookOrderState;
};
