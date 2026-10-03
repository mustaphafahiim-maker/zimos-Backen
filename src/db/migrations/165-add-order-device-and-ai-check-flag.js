'use strict';

/**
 * `orders.device_id`: the browser the storefront order came from (an id the
 * storefront keeps in localStorage). Read by the device blocklist, the "more
 * than two orders from one device in an hour" risk signal and the order
 * page's "Block device".
 *
 * The FeatureFlag `ai_spam_shield` gates the AI text check of moderate-risk
 * orders (SPEC §5.5, P2): seeded off.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('orders', 'device_id', { type: DataTypes.STRING(128), allowNull: true });
    await queryInterface.sequelize.query(
      `CREATE INDEX orders_ws_device_created_idx ON orders (workspace_id, device_id, created_at)
        WHERE device_id IS NOT NULL`
    );
    await queryInterface.sequelize.query(
      `INSERT INTO feature_flags (id, key, description, enabled, rollout, target_workspace_ids, created_at, updated_at)
       VALUES (gen_random_uuid(), 'ai_spam_shield',
               'AI check of moderate-risk orders: the name, address and notes (never the phone) go to the AI provider, and gibberish, abuse or an incomplete address add risk points. The order is never delayed.',
               FALSE, 0, '[]'::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO NOTHING`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DELETE FROM feature_flags WHERE key = 'ai_spam_shield'`);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS orders_ws_device_created_idx');
    await queryInterface.removeColumn('orders', 'device_id');
  },
};
