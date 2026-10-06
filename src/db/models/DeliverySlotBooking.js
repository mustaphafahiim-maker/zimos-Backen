'use strict';

module.exports = (sequelize, DataTypes) => {
  // One order's delivery date and time slot (migration 486, modules/deliverySlots).
  const DeliverySlotBooking = sequelize.define(
    'DeliverySlotBooking',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      deliveryDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'delivery_date' },
      slotId: { type: DataTypes.STRING(40), allowNull: false, field: 'slot_id' },
      startsAt: { type: DataTypes.STRING(5), allowNull: false, field: 'starts_at' },
      endsAt: { type: DataTypes.STRING(5), allowNull: false, field: 'ends_at' },
    },
    { tableName: 'delivery_slot_bookings' }
  );
  DeliverySlotBooking.associate = (models) => {
    DeliverySlotBooking.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return DeliverySlotBooking;
};
