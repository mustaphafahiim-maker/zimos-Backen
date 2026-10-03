'use strict';

/**
 * whatsapp_messages.order_id: which order an outbound message was about.
 * When the customer taps a quick-reply button on that message, Meta's webhook
 * names the message being answered — and through this column, the order to
 * confirm or cancel (modules/whatsapp/quickReplyConfirmation.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('whatsapp_messages', 'order_id', { type: Sequelize.DataTypes.UUID, allowNull: true });
    await queryInterface.addIndex('whatsapp_messages', ['workspace_id', 'wa_message_id'], { name: 'whatsapp_messages_wa_id_idx' });
    await queryInterface.addIndex('whatsapp_messages', ['order_id'], { name: 'whatsapp_messages_order_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('whatsapp_messages', 'whatsapp_messages_order_idx');
    await queryInterface.removeIndex('whatsapp_messages', 'whatsapp_messages_wa_id_idx');
    await queryInterface.removeColumn('whatsapp_messages', 'order_id');
  },
};
