'use strict';

module.exports = (sequelize, DataTypes) => {
  // One of a store's own couriers (migration 216, modules/couriers).
  const Courier = sequelize.define(
    'Courier',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      phone: { type: DataTypes.STRING(32), allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'couriers' }
  );
  return Courier;
};
