'use strict';

module.exports = (sequelize, DataTypes) => {
  // A verified webhook from the billing gateway (migration 129), kept once
  // per (provider, eventKey). Separate from payment_events, which belongs to
  // the stores' own gateways.
  const BillingGatewayEvent = sequelize.define(
    'BillingGatewayEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      provider: { type: DataTypes.STRING(20), allowNull: false },
      // paid (paid or pending) | failed | cancel | refund
      kind: { type: DataTypes.STRING(20), allowNull: false },
      eventKey: { type: DataTypes.STRING(200), allowNull: false, field: 'event_key' },
      attemptId: { type: DataTypes.UUID, allowNull: true, field: 'attempt_id' },
      // The body without its signature and customer details.
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      processedAt: { type: DataTypes.DATE, allowNull: true, field: 'processed_at' },
      outcome: { type: DataTypes.STRING(40), allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'billing_gateway_events' }
  );
  BillingGatewayEvent.associate = (models) => {
    BillingGatewayEvent.belongsTo(models.BillingPaymentAttempt, { foreignKey: 'attemptId', as: 'attempt' });
  };
  return BillingGatewayEvent;
};
