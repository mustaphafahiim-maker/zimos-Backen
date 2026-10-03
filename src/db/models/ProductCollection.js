'use strict';

module.exports = (sequelize, DataTypes) => {
  const ProductCollection = sequelize.define(
    'ProductCollection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      collectionId: { type: DataTypes.UUID, allowNull: false, field: 'collection_id' },
      // The product's place inside the collection, lowest first (migration 118).
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'product_collections',
      indexes: [{ unique: true, fields: ['product_id', 'collection_id'] }, { fields: ['collection_id', 'position'] }],
    }
  );
  return ProductCollection;
};
