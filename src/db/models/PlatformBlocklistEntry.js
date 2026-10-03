'use strict';

module.exports = (sequelize, DataTypes) => {
  // An identifier blocked in every workspace by a platform admin — see
  // migration 103 for what `value` holds per type, and
  // modules/risk/platformBlocklistService for how order creation reads it.
  const PlatformBlocklistEntry = sequelize.define(
    'PlatformBlocklistEntry',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // 'phone' | 'email' | 'address' (CHECK constraint in the migration).
      type: { type: DataTypes.STRING(20), allowNull: false },
      // Normalized: what order creation compares against.
      value: { type: DataTypes.STRING(255), allowNull: false },
      // Human-readable: what the admin blocked, as they saw it.
      label: { type: DataTypes.STRING(600), allowNull: false },
      reason: { type: DataTypes.STRING(300), allowNull: false },
      // Null = never expires. Past = kept for the record, no longer matches.
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    {
      tableName: 'platform_blocklist_entries',
      indexes: [{ unique: true, fields: ['type', 'value'] }, { fields: ['created_at'] }],
    }
  );

  PlatformBlocklistEntry.associate = (models) => {
    PlatformBlocklistEntry.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
  };

  return PlatformBlocklistEntry;
};
