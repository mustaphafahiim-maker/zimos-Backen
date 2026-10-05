'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Phones that asked a store to stop marketing messages (a STOP reply on
 * WhatsApp). Kept apart from customers: the person may never have ordered
 * (an abandoned checkout), and the opt-out must hold all the same.
 * Recovery, review-request and lead automations skip these phones
 * (automations/marketingGuard.js); a newsletter sign-up by the same phone
 * removes the row (the person opted back in).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    await queryInterface.createTable('marketing_opt_outs', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      phone_normalized: { type: DataTypes.STRING(32), allowNull: false },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'whatsapp' },
      word: { type: DataTypes.STRING(40), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('marketing_opt_outs', ['workspace_id', 'phone_normalized'], { unique: true, name: 'marketing_opt_outs_ws_phone_uq' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('marketing_opt_outs');
  },
};
