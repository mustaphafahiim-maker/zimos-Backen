'use strict';

module.exports = (sequelize, DataTypes) => {
  // The platform's app catalogue (modules/apps). Names and descriptions live
  // in appCatalogue.js; this row carries what the platform admin decides.
  const App = sequelize.define(
    'App',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      category: { type: DataTypes.STRING(40), allowNull: false },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      // Null until pricing is decided: the app is shown as free.
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      billing: { type: DataTypes.STRING(20), allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      displayOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'display_order' },
    },
    { tableName: 'apps' }
  );
  return App;
};
