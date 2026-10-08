'use strict';

/**
 * Customer messages in the shopper's language (item 383, orders/orderLocale.js):
 *
 *   orders.locale, checkout_sessions.locale   the language the shopper used the
 *       store in (X-Store-Locale at checkout); null on older rows = the store's default
 *   order_email_templates.locale              a store's email in one more language;
 *       null = the default version (every row from before keeps null)
 *
 * The emails' unique key becomes (workspace, key, scope, locale), with the null
 * locale counted as one value (COALESCE) so the default version stays single.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('orders', 'locale', { type: Sequelize.STRING(10), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'locale', { type: Sequelize.STRING(10), allowNull: true });
    await queryInterface.addColumn('order_email_templates', 'locale', { type: Sequelize.STRING(10), allowNull: true });
    await queryInterface.removeIndex('order_email_templates', 'order_email_templates_workspace_key_scope_idx');
    await queryInterface.sequelize.query(
      "CREATE UNIQUE INDEX order_email_templates_workspace_key_scope_locale_idx ON order_email_templates (workspace_id, key, scope, (COALESCE(locale, '')))"
    );
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DELETE FROM order_email_templates WHERE locale IS NOT NULL');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS order_email_templates_workspace_key_scope_locale_idx');
    await queryInterface.addIndex('order_email_templates', ['workspace_id', 'key', 'scope'], { unique: true, name: 'order_email_templates_workspace_key_scope_idx' });
    await queryInterface.removeColumn('order_email_templates', 'locale');
    await queryInterface.removeColumn('checkout_sessions', 'locale');
    await queryInterface.removeColumn('orders', 'locale');
  },
};
