'use strict';

module.exports = (sequelize, DataTypes) => {
  // A reminder to get back to a customer (migration 479, modules/customerNotes).
  const CustomerFollowup = sequelize.define(
    'CustomerFollowup',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      assigneeUserId: { type: DataTypes.UUID, allowNull: true, field: 'assignee_user_id' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      dueAt: { type: DataTypes.DATE, allowNull: false, field: 'due_at' },
      doneAt: { type: DataTypes.DATE, allowNull: true, field: 'done_at' },
      notifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'notified_at' },
    },
    { tableName: 'customer_followups' }
  );
  CustomerFollowup.associate = (models) => {
    CustomerFollowup.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    CustomerFollowup.belongsTo(models.User, { foreignKey: 'assigneeUserId', as: 'assignee' });
  };
  return CustomerFollowup;
};
