'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The customer service bot on WhatsApp (SPEC §19.3).
 *
 *   whatsapp_conversations.bot_paused_at   set when a teammate takes the
 *                                          conversation over or the bot hands
 *                                          it to them; the bot stays quiet
 *                                          there until someone lets it answer
 *   whatsapp_conversations.bot_state       what the bot is in the middle of
 *                                          (taking an order, step by step)
 *   whatsapp_messages.sent_by_bot          the inbox's "bot" badge, and the
 *                                          monthly count of replies
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('whatsapp_conversations', 'bot_paused_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn('whatsapp_conversations', 'bot_state', { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }, { transaction });
      await queryInterface.addColumn('whatsapp_messages', 'sent_by_bot', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, { transaction });
      await queryInterface.addIndex('whatsapp_messages', ['workspace_id', 'created_at'], {
        name: 'whatsapp_messages_bot_replies_idx',
        where: { sent_by_bot: true },
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex('whatsapp_messages', 'whatsapp_messages_bot_replies_idx', { transaction });
      await queryInterface.removeColumn('whatsapp_messages', 'sent_by_bot', { transaction });
      await queryInterface.removeColumn('whatsapp_conversations', 'bot_state', { transaction });
      await queryInterface.removeColumn('whatsapp_conversations', 'bot_paused_at', { transaction });
    });
  },
};
