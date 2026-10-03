'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per (workspace, product, customer). A resubmission updates the
  // same row and drops it back to `pending`. See modules/reviews/reviewService.js.
  const Review = sequelize.define(
    'Review',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      // Null for a review the merchant added by hand (migration 186, reviews/manualReviews.js).
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      authorName: { type: DataTypes.STRING(120), allowNull: true, field: 'author_name' },
      photos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      // 'customer' (submitted from the storefront after delivery) or 'manual'.
      source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'customer' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
      comment: { type: DataTypes.TEXT, allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
    },
    {
      tableName: 'reviews',
      indexes: [
        { unique: true, fields: ['workspace_id', 'product_id', 'customer_id'] },
        { fields: ['workspace_id', 'product_id', 'status'] },
        { fields: ['workspace_id', 'status'] },
      ],
    }
  );

  Review.associate = (models) => {
    Review.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    Review.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    Review.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };

  return Review;
};
