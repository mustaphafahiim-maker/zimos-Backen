'use strict';

module.exports = (sequelize, DataTypes) => {
  // One provider's service in the merchants' services directory (migration
  // 316). Platform-wide; written from platform-admin only.
  const ServiceListing = sequelize.define(
    'ServiceListing',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      category: { type: DataTypes.STRING(30), allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      titleAr: { type: DataTypes.STRING(200), allowNull: true, field: 'title_ar' },
      description: { type: DataTypes.STRING(2000), allowNull: false },
      descriptionAr: { type: DataTypes.STRING(2000), allowNull: true, field: 'description_ar' },
      providerName: { type: DataTypes.STRING(200), allowNull: false, field: 'provider_name' },
      providerLogoUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'provider_logo_url' },
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount' },
      priceCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'price_currency' },
      priceUnit: { type: DataTypes.STRING(60), allowNull: true, field: 'price_unit' },
      contactWhatsapp: { type: DataTypes.STRING(32), allowNull: true, field: 'contact_whatsapp' },
      contactUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'contact_url' },
      contactEmail: { type: DataTypes.STRING(255), allowNull: true, field: 'contact_email' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'service_listings', indexes: [{ fields: ['is_active', 'category', 'position'], name: 'service_listings_active_idx' }] }
  );
  return ServiceListing;
};
