'use strict';

module.exports = (sequelize, DataTypes) => {
  // One variant's price before and during a scheduled sale (migration 490).
  const PriceScheduleItem = sequelize.define(
    'PriceScheduleItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      scheduleId: { type: DataTypes.UUID, allowNull: false, field: 'schedule_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      oldPrice: { type: DataTypes.BIGINT, allowNull: false, field: 'old_price' },
      oldCompareAt: { type: DataTypes.BIGINT, allowNull: true, field: 'old_compare_at' },
      newPrice: { type: DataTypes.BIGINT, allowNull: false, field: 'new_price' },
      newCompareAt: { type: DataTypes.BIGINT, allowNull: true, field: 'new_compare_at' },
      state: { type: DataTypes.STRING(10), allowNull: false },
    },
    { tableName: 'price_schedule_items' }
  );
  return PriceScheduleItem;
};
