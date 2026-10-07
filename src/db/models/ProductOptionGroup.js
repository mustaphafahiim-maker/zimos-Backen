'use strict';

module.exports = (sequelize, DataTypes) => {
  // A product's option group ("Size", "Extras") — migration 218, catalog/menuOptions.js.
  const ProductOptionGroup = sequelize.define(
    'ProductOptionGroup',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      minSelect: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'min_select' },
      maxSelect: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'max_select' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
    },
    { tableName: 'product_option_groups' }
  );
  ProductOptionGroup.associate = (models) => {
    ProductOptionGroup.hasMany(models.ProductOptionChoice, { foreignKey: 'groupId', as: 'choices' });
  };
  return ProductOptionGroup;
};
