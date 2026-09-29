'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * Confirmation tasks can be handed to one agent, and each call attempt records
 * how the customer was reached.
 *
 *  - confirmation_tasks.assigned_to_user_id / assigned_at: a manager assigns a
 *    task to an agent; only that agent (or a manager) may then claim it. Null
 *    is "anyone may take it", which is every task that exists today. ON DELETE
 *    SET NULL frees a deleted user's tasks back to the whole team.
 *  - confirmation_attempts.channel: 'call' / 'whatsapp' / 'other', checked in
 *    the API (confirmationValidation.js), not by an ENUM, so adding a channel
 *    later needs no ALTER TYPE. Null for every attempt recorded before this.
 *
 * The queue's "assigned to me / unassigned / this agent" filters read
 * (workspace_id, assigned_to_user_id, status). confirmation_tasks grows with
 * every COD order, so the index is built CONCURRENTLY (see ../concurrentIndex.js),
 * after the columns — which is why this file runs its steps one at a time
 * with no transaction around them.
 */
const INDEX = 'confirmation_tasks_workspace_assignee_status_idx';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tasks = await queryInterface.describeTable('confirmation_tasks');
    if (!tasks.assigned_to_user_id) {
      await queryInterface.addColumn('confirmation_tasks', 'assigned_to_user_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
    if (!tasks.assigned_at) {
      await queryInterface.addColumn('confirmation_tasks', 'assigned_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    const attempts = await queryInterface.describeTable('confirmation_attempts');
    if (!attempts.channel) {
      await queryInterface.addColumn('confirmation_attempts', 'channel', {
        type: Sequelize.STRING(16),
        allowNull: true,
      });
    }

    await createIndexConcurrently(queryInterface, {
      name: INDEX,
      table: 'confirmation_tasks',
      definition: '(workspace_id, assigned_to_user_id, status)',
    });
  },

  down: async (queryInterface) => {
    await dropIndexConcurrently(queryInterface, INDEX);
    await queryInterface.removeColumn('confirmation_attempts', 'channel');
    await queryInterface.removeColumn('confirmation_tasks', 'assigned_at');
    await queryInterface.removeColumn('confirmation_tasks', 'assigned_to_user_id');
  },
};
