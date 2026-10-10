'use strict';

module.exports = (sequelize, DataTypes) => {
  // A shopper's question on a product and the store's answer (migration 641, modules/productQuestions).
  const ProductQuestion = sequelize.define(
    'ProductQuestion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      question: { type: DataTypes.TEXT, allowNull: false },
      askerName: { type: DataTypes.STRING(120), allowNull: true, field: 'asker_name' },
      askerEmail: { type: DataTypes.STRING(255), allowNull: true, field: 'asker_email' },
      locale: { type: DataTypes.STRING(5), allowNull: true },
      answer: { type: DataTypes.TEXT, allowNull: true },
      answeredBy: { type: DataTypes.UUID, allowNull: true, field: 'answered_by' },
      answeredAt: { type: DataTypes.DATE, allowNull: true, field: 'answered_at' },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      requestIp: { type: DataTypes.STRING(45), allowNull: true, field: 'request_ip' },
    },
    { tableName: 'product_questions' }
  );
  ProductQuestion.associate = (models) => {
    ProductQuestion.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
  };
  return ProductQuestion;
};
