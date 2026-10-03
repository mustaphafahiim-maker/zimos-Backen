'use strict';

/**
 * Manual transfers (InstaPay, Vodafone Cash, bank): the shopper pays outside
 * the store and uploads a receipt; the merchant confirms or rejects it. The
 * payment row carries the receipt, the sender and who reviewed it. `purpose`
 * tells a deposit (part of a COD order paid in advance) from a full payment.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('payments', 'receipt_upload_id', {
      type: DataTypes.UUID, allowNull: true, references: { model: 'customer_uploads', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn('payments', 'sender_reference', { type: DataTypes.STRING(100), allowNull: true });
    await queryInterface.addColumn('payments', 'manual_method_name', { type: DataTypes.STRING(100), allowNull: true });
    await queryInterface.addColumn('payments', 'purpose', { type: DataTypes.STRING(20), allowNull: true });
    await queryInterface.addColumn('payments', 'reviewed_by_user_id', {
      type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn('payments', 'reviewed_at', { type: DataTypes.DATE, allowNull: true });
  },

  down: async (queryInterface) => {
    for (const column of ['reviewed_at', 'reviewed_by_user_id', 'purpose', 'manual_method_name', 'sender_reference', 'receipt_upload_id']) {
      await queryInterface.removeColumn('payments', column);
    }
  },
};
