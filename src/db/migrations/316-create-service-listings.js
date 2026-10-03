'use strict';

/**
 * Services marketplace (SPEC §20.5): a directory of service providers for
 * merchants, managed from platform-admin. Platform-wide — no workspace.
 * Payment between a merchant and a provider happens outside ZIMOS.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    await queryInterface.createTable('service_listings', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      title_ar: { type: DataTypes.STRING(200), allowNull: true },
      description: { type: DataTypes.STRING(2000), allowNull: false },
      description_ar: { type: DataTypes.STRING(2000), allowNull: true },
      provider_name: { type: DataTypes.STRING(200), allowNull: false },
      provider_logo_url: { type: DataTypes.STRING(1000), allowNull: true },
      // The provider's own price, as they state it. null = "ask for a quote".
      price_amount: { type: DataTypes.BIGINT, allowNull: true },
      price_currency: { type: DataTypes.STRING(3), allowNull: true },
      price_unit: { type: DataTypes.STRING(60), allowNull: true },
      contact_whatsapp: { type: DataTypes.STRING(32), allowNull: true },
      contact_url: { type: DataTypes.STRING(1000), allowNull: true },
      contact_email: { type: DataTypes.STRING(255), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('service_listings', ['is_active', 'category', 'position'], { name: 'service_listings_active_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('service_listings');
  },
};
