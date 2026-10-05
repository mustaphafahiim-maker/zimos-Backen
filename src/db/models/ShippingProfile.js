'use strict';

module.exports = (sequelize, DataTypes) => {
  // A shipping group: its own prices for the products in it (migration 410, shipping/shippingProfiles.js).
  const ShippingProfile = sequelize.define(
    'ShippingProfile',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      flatAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'flat_amount' },
      governorateAmounts: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'governorate_amounts' },
      // The currency its prices are in; null = the store's (migration 434).
      currency: { type: DataTypes.STRING(3), allowNull: true },
    },
    { tableName: 'shipping_profiles' }
  );
  return ShippingProfile;
};
