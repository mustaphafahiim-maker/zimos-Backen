'use strict';

module.exports = (sequelize, DataTypes) => {
  // A platform-console role (migration 105). Roles are data: a key, a display
  // name and the default permission set copied onto an account when the role
  // is assigned. What an account can do is its own permission set, not this.
  const PlatformRole = sequelize.define(
    'PlatformRole',
    {
      key: { type: DataTypes.STRING(64), primaryKey: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      defaultPermissions: {
        type: DataTypes.ARRAY(DataTypes.STRING(64)),
        allowNull: false,
        defaultValue: [],
        field: 'default_permissions',
      },
    },
    { tableName: 'platform_roles' }
  );
  return PlatformRole;
};
