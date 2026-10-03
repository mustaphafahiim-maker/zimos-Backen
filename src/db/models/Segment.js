'use strict';

module.exports = (sequelize, DataTypes) => {
  // A saved contact filter. `rules` is the shape checked by
  // modules/contacts/segmentRules.js and is evaluated every time it is used.
  const Segment = sequelize.define(
    'Segment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.STRING(300), allowNull: true },
      rules: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      tableName: 'segments',
      indexes: [{ unique: true, fields: ['workspace_id', 'name'], name: 'segments_ws_name_uq' }],
    }
  );
  return Segment;
};
