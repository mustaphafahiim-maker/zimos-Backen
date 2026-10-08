'use strict';

/**
 * The shopper confirms their cash-on-delivery order from a link (spec-gaps
 * item 388, cod/customerLinkConfirmation.js). That outcome is recorded as a
 * confirmation attempt like an agent's, with channel `customer_link` — but no
 * team member made it, so confirmation_attempts.agent_user_id may now be null
 * (null = the customer).
 *
 * down: a customer's attempt is handed to the store's owner (the account the
 * WhatsApp button path already records), then the column is NOT NULL again.
 * An attempt in a store with no owner left cannot be kept and is removed.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE confirmation_attempts ALTER COLUMN agent_user_id DROP NOT NULL');
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `UPDATE confirmation_attempts a
          SET agent_user_id = (
                SELECT m.user_id
                  FROM confirmation_tasks t
                  JOIN memberships m ON m.workspace_id = t.workspace_id AND m.status = 'active' AND m.user_id IS NOT NULL
                  JOIN roles r ON r.id = m.role_id AND r.key = 'owner'
                 WHERE t.id = a.task_id
                 ORDER BY m.created_at
                 LIMIT 1)
        WHERE a.agent_user_id IS NULL`
    );
    await queryInterface.sequelize.query('DELETE FROM confirmation_attempts WHERE agent_user_id IS NULL');
    await queryInterface.sequelize.query('ALTER TABLE confirmation_attempts ALTER COLUMN agent_user_id SET NOT NULL');
  },
};
