'use strict';

module.exports = (sequelize, DataTypes) => {
  const Collection = sequelize.define(
    'Collection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      rules: { type: DataTypes.JSONB, allowNull: true }, // smart-collection rules, null = manual collection
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // The tree (migration 118): null is a top-level collection. At most
      // three levels and never a cycle — enforced by catalog/collectionTree.js.
      parentId: { type: DataTypes.UUID, allowNull: true, field: 'parent_id' },
      // Order among siblings: lowest first, then by name.
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      imageUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'image_url' },
    },
    {
      tableName: 'collections',
      indexes: [{ unique: true, fields: ['workspace_id', 'slug'] }, { fields: ['workspace_id', 'parent_id', 'position'] }],
    }
  );

  Collection.associate = (models) => {
    Collection.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Collection.belongsTo(models.Collection, { foreignKey: 'parentId', as: 'parent' });
    Collection.hasMany(models.Collection, { foreignKey: 'parentId', as: 'children' });
    Collection.belongsToMany(models.Product, {
      through: models.ProductCollection,
      foreignKey: 'collectionId',
      otherKey: 'productId',
      as: 'products',
    });
  };

  return Collection;
};
