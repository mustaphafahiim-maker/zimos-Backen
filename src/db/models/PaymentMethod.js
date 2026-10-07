'use strict';

module.exports = (sequelize, DataTypes) => {
  // One way a merchant can pay Zimos (migration 130, billing/paymentMethodService).
  // Never a secret: a gateway's keys live in the environment only.
  const PaymentMethod = sequelize.define(
    'PaymentMethod',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // 'manual' (a transfer the merchant proves with a screenshot) | 'gateway'
      kind: { type: DataTypes.STRING(10), allowNull: false },
      // instapay, wallet, fawaterak, … — a gateway's code names its adapter.
      code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      labelAr: { type: DataTypes.STRING(80), allowNull: false, field: 'label_ar' },
      labelEn: { type: DataTypes.STRING(80), allowNull: false, field: 'label_en' },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Manual only: where the money goes, and how to send it.
      accountNumber: { type: DataTypes.STRING(80), allowNull: true, field: 'account_number' },
      // Optional, https only (migration 210); null = no link.
      paymentLink: { type: DataTypes.STRING(500), allowNull: true, field: 'payment_link' },
      noteAr: { type: DataTypes.STRING(500), allowNull: true, field: 'note_ar' },
      noteEn: { type: DataTypes.STRING(500), allowNull: true, field: 'note_en' },
    },
    { tableName: 'payment_methods' }
  );
  PaymentMethod.KINDS = ['manual', 'gateway'];
  return PaymentMethod;
};
