'use strict';

module.exports = (sequelize, DataTypes) => {
  // One submit of a page `form` element — see modules/contacts/formService.js,
  // the only writer.
  const FormSubmission = sequelize.define(
    'FormSubmission',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      formName: { type: DataTypes.STRING(200), allowNull: false, field: 'form_name' },
      pagePath: { type: DataTypes.STRING(500), allowNull: true, field: 'page_path' },
      elementId: { type: DataTypes.STRING(100), allowNull: true, field: 'element_id' },
      fullName: { type: DataTypes.STRING(200), allowNull: true, field: 'full_name' },
      phone: { type: DataTypes.STRING(32), allowNull: true },
      email: { type: DataTypes.STRING(255), allowNull: true },
      message: { type: DataTypes.TEXT, allowNull: true },
      // Any further fields the form carried, as label → text.
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
      marketingConsent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'marketing_consent' },
      ipAddress: { type: DataTypes.STRING(64), allowNull: true, field: 'ip_address' },
      isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_read' },
    },
    {
      tableName: 'form_submissions',
      indexes: [
        { fields: ['workspace_id', 'created_at', 'id'], name: 'form_submissions_ws_created_idx' },
        { fields: ['customer_id'], name: 'form_submissions_customer_idx' },
      ],
    }
  );

  FormSubmission.associate = (models) => {
    FormSubmission.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
  };
  return FormSubmission;
};
