'use strict';

module.exports = (sequelize, DataTypes) => {
  // One blocked identifier of a store, per scope — see migration 160 and
  // modules/fraud/blockedEntries.js, the only writer.
  const BlockedEntry = sequelize.define(
    'BlockedEntry',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // 'phone' | 'ip' | 'email' | 'device' | 'name_address'
      type: { type: DataTypes.STRING(20), allowNull: false },
      // Normalized: what order creation compares against.
      value: { type: DataTypes.STRING(255), allowNull: false },
      // Human-readable: what the merchant blocked, as they typed it.
      label: { type: DataTypes.STRING(600), allowNull: false },
      // 'orders' | 'otp' | 'visit'
      scope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'orders' },
      reason: { type: DataTypes.STRING(300), allowNull: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      tableName: 'blocked_entries',
      indexes: [
        { unique: true, fields: ['workspace_id', 'type', 'scope', 'value'], name: 'blocked_entries_ws_type_scope_value_uq' },
        { fields: ['workspace_id', 'created_at', 'id'], name: 'blocked_entries_ws_created_idx' },
      ],
    }
  );

  BlockedEntry.associate = (models) => {
    BlockedEntry.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
  };

  return BlockedEntry;
};
