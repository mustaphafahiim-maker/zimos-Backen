'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per (workspace, slot): the merchant's own code for that slot of
  // their store. See modules/customCode/customCodeService.js for the slots.
  const WorkspaceCustomCode = sequelize.define(
    'WorkspaceCustomCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      slot: { type: DataTypes.STRING(40), allowNull: false },
      html: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_active' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      // A store script's name, position and page types (customCode/storeScripts.js).
      options: { type: DataTypes.JSONB, allowNull: true },
    },
    {
      tableName: 'workspace_custom_code',
      indexes: [{ unique: true, fields: ['workspace_id', 'slot'] }],
    }
  );
  return WorkspaceCustomCode;
};
