'use strict';

/** Delivery date and time slots booked at checkout (modules/deliverySlots, spec-gaps item 221). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('delivery_slot_bookings', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      // Null for the few seconds between holding the slot and creating the order.
      order_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      // The store's local date of delivery.
      delivery_date: { type: Sequelize.DATEONLY, allowNull: false },
      slot_id: { type: Sequelize.STRING(40), allowNull: false },
      starts_at: { type: Sequelize.STRING(5), allowNull: false },
      ends_at: { type: Sequelize.STRING(5), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('delivery_slot_bookings', ['workspace_id', 'delivery_date', 'slot_id'], { name: 'delivery_slot_bookings_day_idx' });
    await queryInterface.addIndex('delivery_slot_bookings', ['order_id'], { name: 'delivery_slot_bookings_order_uq', unique: true });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('delivery_slot_bookings');
  },
};
