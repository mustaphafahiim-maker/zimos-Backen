'use strict';

module.exports = (sequelize, DataTypes) => {
  // Tracks a checkout in progress for abandoned-checkout detection/recovery.
  // Closed/converted the moment the linked order is successfully created.
  const CheckoutSession = sequelize.define(
    'CheckoutSession',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      cartId: { type: DataTypes.UUID, allowNull: true, field: 'cart_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: true, field: 'visitor_id' },
      contactFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'contact_fields' },
      attribution: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: {
        type: DataTypes.ENUM('in_progress', 'converted', 'abandoned'),
        allowNull: false,
        defaultValue: 'in_progress',
      },
      convertedOrderId: { type: DataTypes.UUID, allowNull: true, field: 'converted_order_id' },
      lastActivityAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'last_activity_at' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: true, field: 'phone_normalized' },
      customerName: { type: DataTypes.STRING(200), allowNull: true, field: 'customer_name' },
      items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      subtotalAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'subtotal_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'store' },
      recoveryStatus: {
        type: DataTypes.ENUM('not_contacted', 'contacted', 'recovered', 'lost'),
        allowNull: false,
        defaultValue: 'not_contacted',
        field: 'recovery_status',
      },
      contactedAt: { type: DataTypes.DATE, allowNull: true, field: 'contacted_at' },
    },
    { tableName: 'checkout_sessions', indexes: [{ fields: ['workspace_id', 'status'] }, { fields: ['cart_id'] }] }
  );
  return CheckoutSession;
};
