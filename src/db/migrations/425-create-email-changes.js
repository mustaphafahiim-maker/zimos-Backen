'use strict';

/**
 * email_changes (SPEC §17.3 "account settings: … owner email"): a sign-in
 * email change waiting for the new address to be confirmed. The link sent to
 * the new address carries a token; only its SHA-256 hash is kept, like
 * verification_tokens. A new request replaces the pending one
 * (auth/emailChange.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('email_changes', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      old_email: { type: DataTypes.STRING(255), allowNull: false },
      new_email: { type: DataTypes.STRING(255), allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      // Confirmed, replaced by a newer request, or cancelled.
      used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('email_changes', ['token_hash'], { unique: true, name: 'email_changes_token_uniq' });
    await queryInterface.addIndex('email_changes', ['user_id', 'used_at'], { name: 'email_changes_user_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('email_changes');
  },
};
