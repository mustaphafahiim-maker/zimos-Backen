'use strict';

/**
 * An opt-out can name an email address as well as (or instead of) a phone:
 * the unsubscribe link in the abandoned-cart email (notifications/
 * marketingUnsubscribe.js) records the address, and the phone too when the
 * checkout had one. A checkout left with a name and an email only has no
 * phone to record. Emails are stored lowercased.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('marketing_opt_outs', 'email', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.changeColumn('marketing_opt_outs', 'phone_normalized', { type: Sequelize.STRING(32), allowNull: true });
    await queryInterface.sequelize.query(
      'ALTER TABLE marketing_opt_outs ADD CONSTRAINT marketing_opt_outs_phone_or_email CHECK (phone_normalized IS NOT NULL OR email IS NOT NULL)'
    );
    await queryInterface.addIndex('marketing_opt_outs', ['workspace_id', 'email'], {
      unique: true,
      name: 'marketing_opt_outs_ws_email_uq',
      where: { email: { [Sequelize.Op.ne]: null } },
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('marketing_opt_outs', 'marketing_opt_outs_ws_email_uq');
    await queryInterface.sequelize.query('ALTER TABLE marketing_opt_outs DROP CONSTRAINT IF EXISTS marketing_opt_outs_phone_or_email');
    await queryInterface.sequelize.query('DELETE FROM marketing_opt_outs WHERE phone_normalized IS NULL');
    await queryInterface.changeColumn('marketing_opt_outs', 'phone_normalized', { type: Sequelize.STRING(32), allowNull: false });
    await queryInterface.removeColumn('marketing_opt_outs', 'email');
  },
};
