'use strict';

module.exports = (sequelize, DataTypes) => {
  // 1 unit of `base` = `rate` units of `quote`. One row per pair, replaced by each refresh.
  const FxRate = sequelize.define(
    'FxRate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      base: { type: DataTypes.STRING(3), allowNull: false },
      quote: { type: DataTypes.STRING(3), allowNull: false },
      rate: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
      source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'sandbox' },
      fetchedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'fetched_at' },
    },
    { tableName: 'fx_rates', indexes: [{ unique: true, fields: ['base', 'quote'] }] }
  );
  return FxRate;
};
