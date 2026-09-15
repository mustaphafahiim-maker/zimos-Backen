'use strict';

/**
 * Abandoned-checkout recovery. A checkout session is recorded as soon as a
 * shopper types a usable phone/email on the checkout form, including "Buy now"
 * flows that have no cart — so cart_id becomes optional — with a snapshot of
 * what they were buying and a merchant-facing recovery status.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.query('ALTER TABLE checkout_sessions ALTER COLUMN cart_id DROP NOT NULL;');
    await queryInterface.addColumn('checkout_sessions', 'phone_normalized', { type: DataTypes.STRING(32), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'customer_name', { type: DataTypes.STRING(200), allowNull: true });
    await queryInterface.addColumn('checkout_sessions', 'items', { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addColumn('checkout_sessions', 'subtotal_amount', { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('checkout_sessions', 'currency', { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' });
    await queryInterface.addColumn('checkout_sessions', 'source', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'store' });
    await queryInterface.addColumn('checkout_sessions', 'recovery_status', {
      type: DataTypes.ENUM('not_contacted', 'contacted', 'recovered', 'lost'),
      allowNull: false,
      defaultValue: 'not_contacted',
    });
    await queryInterface.addColumn('checkout_sessions', 'contacted_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addIndex('checkout_sessions', ['workspace_id', 'phone_normalized'], { name: 'checkout_sessions_workspace_phone_idx' });
    await queryInterface.addIndex('checkout_sessions', ['workspace_id', 'last_activity_at'], { name: 'checkout_sessions_workspace_activity_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('checkout_sessions', 'checkout_sessions_workspace_activity_idx');
    await queryInterface.removeIndex('checkout_sessions', 'checkout_sessions_workspace_phone_idx');
    for (const column of ['contacted_at', 'recovery_status', 'source', 'currency', 'subtotal_amount', 'items', 'customer_name', 'phone_normalized']) {
      await queryInterface.removeColumn('checkout_sessions', column);
    }
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_checkout_sessions_recovery_status";');
    await queryInterface.sequelize.query('DELETE FROM checkout_sessions WHERE cart_id IS NULL;');
    await queryInterface.sequelize.query('ALTER TABLE checkout_sessions ALTER COLUMN cart_id SET NOT NULL;');
  },
};
