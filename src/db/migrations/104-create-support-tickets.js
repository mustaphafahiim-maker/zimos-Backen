'use strict';

/**
 * Merchant support tickets (modules/support).
 *
 * support_tickets: one conversation between a workspace and the platform
 * team. `status` is the queue position:
 *
 *   open      waiting on the platform team (new, or the merchant replied)
 *   pending   waiting on the merchant (the platform team replied)
 *   resolved  answered; a merchant reply re-opens it
 *   closed    finished; no further replies
 *
 * support_ticket_messages: the thread, oldest first. `author_type` says which
 * side wrote it; the author row itself may later be deleted (SET NULL).
 *
 * Deleting a workspace deletes its tickets and their messages.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'support_tickets',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          created_by_user_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          subject: { type: DataTypes.STRING(200), allowNull: false },
          category: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'general' },
          status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
          priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'normal' },
          last_message_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          last_message_by: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'merchant' },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE support_tickets
           ADD CONSTRAINT support_tickets_status_check CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
           ADD CONSTRAINT support_tickets_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
           ADD CONSTRAINT support_tickets_category_check
             CHECK (category IN ('general', 'billing', 'orders', 'shipping', 'payments', 'technical', 'account')),
           ADD CONSTRAINT support_tickets_last_message_by_check CHECK (last_message_by IN ('merchant', 'admin'))`,
        { transaction }
      );
      // The merchant's own list.
      await queryInterface.addIndex('support_tickets', ['workspace_id', 'created_at'], {
        name: 'support_tickets_workspace_created_idx',
        transaction,
      });
      // The platform queue: by status, most recently active first.
      await queryInterface.addIndex('support_tickets', ['status', 'last_message_at'], {
        name: 'support_tickets_status_last_message_idx',
        transaction,
      });

      await queryInterface.createTable(
        'support_ticket_messages',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          ticket_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'support_tickets', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          author_user_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          author_type: { type: DataTypes.STRING(10), allowNull: false },
          body: { type: DataTypes.TEXT, allowNull: false },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE support_ticket_messages
           ADD CONSTRAINT support_ticket_messages_author_type_check CHECK (author_type IN ('merchant', 'admin'))`,
        { transaction }
      );
      await queryInterface.addIndex('support_ticket_messages', ['ticket_id', 'created_at'], {
        name: 'support_ticket_messages_ticket_created_idx',
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('support_ticket_messages', { transaction });
      await queryInterface.dropTable('support_tickets', { transaction });
    });
  },
};
