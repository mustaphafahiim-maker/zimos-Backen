'use strict';

module.exports = (sequelize, DataTypes) => {
  // Units of a variant at a non-default location (migration 477); the default location holds the rest.
  const LocationStock = sequelize.define(
    'LocationStock',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      locationId: { type: DataTypes.UUID, allowNull: false, field: 'location_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      onHand: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'on_hand' },
    },
    { tableName: 'location_stock' }
  );
  return LocationStock;
};
