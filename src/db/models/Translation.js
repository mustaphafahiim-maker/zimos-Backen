'use strict';

module.exports = (sequelize, DataTypes) => {
  // One translated field of one entity in one language — modules/translations.
  const Translation = sequelize.define(
    'Translation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      entityType: { type: DataTypes.STRING(40), allowNull: false, field: 'entity_type' },
      entityId: { type: DataTypes.UUID, allowNull: false, field: 'entity_id' },
      locale: { type: DataTypes.STRING(10), allowNull: false },
      field: { type: DataTypes.STRING(60), allowNull: false },
      value: { type: DataTypes.TEXT, allowNull: false },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      tableName: 'translations',
      indexes: [
        { unique: true, fields: ['workspace_id', 'entity_type', 'entity_id', 'locale', 'field'] },
        { fields: ['workspace_id', 'locale'] },
      ],
    }
  );
  return Translation;
};
