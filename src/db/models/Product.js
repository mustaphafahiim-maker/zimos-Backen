'use strict';

module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define(
    'Product',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      name: { type: DataTypes.STRING(300), allowNull: false },
      slug: { type: DataTypes.STRING(300), allowNull: false },
      // Distinct 9-digit code, assigned by the server on create (not the UUID
      // PK, not the order-number pattern). See catalogService.generateProductCode.
      productCode: { type: DataTypes.STRING(9), allowNull: false, field: 'product_code' },
      description: { type: DataTypes.TEXT, allowNull: true },
      productType: {
        type: DataTypes.ENUM('physical', 'digital', 'service'),
        allowNull: false,
        defaultValue: 'physical',
        field: 'product_type',
      },
      status: {
        type: DataTypes.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      options: {
        // e.g. [{ name: 'Color', values: ['Red','Blue'] }, { name: 'Size', values: ['S','M'] }]
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      media: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // How this product ships — see migration 114 and shipping/shippingRules.
      // 'standard' uses the store's rates; 'free' ships free (the whole order
      // only when every line is free); 'extra_fee' adds shippingExtraAmount
      // per unit on top of the store's rate. The amount is set exactly when
      // the mode is 'extra_fee' (a DB check enforces it).
      shippingMode: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'standard',
        field: 'shipping_mode',
      },
      shippingExtraAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'shipping_extra_amount' },
      // Its shipping group, when it has its own prices (migration 187, shipping/shippingProfiles.js).
      shippingProfileId: { type: DataTypes.UUID, allowNull: true, field: 'shipping_profile_id' },
      // Fields the shopper fills in when ordering (catalog/customFields.js), at most five.
      customFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'custom_fields' },
      // SPEC §7.1–7.4 — see migration 145 and catalog/productPage.js.
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      specialOfferText: { type: DataTypes.STRING(200), allowNull: true, field: 'special_offer_text' },
      externalRefs: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'external_refs' },
      pageSettings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'page_settings' },
      // Sold beyond stock as a pre-order (migration 643, modules/preorders): { enabled, shipsAt, limit, message }.
      preorder: { type: DataTypes.JSONB, allowNull: true },
      cms: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // The quantity bundle this product sells with (migration 149, modules/bundles).
      bundleId: { type: DataTypes.UUID, allowNull: true, field: 'bundle_id' },
    },
    {
      tableName: 'products',
      indexes: [
        { unique: true, fields: ['workspace_id', 'slug'] },
        { unique: true, fields: ['product_code'] },
        { fields: ['workspace_id', 'status'] },
      ],
    }
  );

  Product.associate = (models) => {
    Product.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Product.hasMany(models.ProductVariant, { foreignKey: 'productId', as: 'variants' });
    Product.hasMany(models.Offer, { foreignKey: 'productId', as: 'offers' });
    Product.belongsToMany(models.Collection, {
      through: models.ProductCollection,
      foreignKey: 'productId',
      otherKey: 'collectionId',
      as: 'collections',
    });
  };

  return Product;
};
