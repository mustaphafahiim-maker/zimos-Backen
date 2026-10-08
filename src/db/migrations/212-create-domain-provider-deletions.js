'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Custom hostnames still to remove at the certificate provider (Cloudflare
 * for SaaS). When a merchant removes a domain and the provider's DELETE
 * fails, the domain row goes anyway and one row here remembers the
 * provider's id; the domains job retries it (modules/domains/jobs.js) until
 * the provider confirms or answers 404. No foreign key to workspaces: the
 * hostname exists at the provider whatever happens to the store.
 *
 * Also domains.ssl_detail: the provider's reason when a certificate fails,
 * shown to the merchant as is.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') };
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'domain_provider_deletions',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
          workspace_id: { type: DataTypes.UUID, allowNull: true },
          hostname: { type: DataTypes.STRING(255), allowNull: false },
          provider: { type: DataTypes.STRING(40), allowNull: false },
          provider_ref: { type: DataTypes.STRING(200), allowNull: false },
          attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          last_error: { type: DataTypes.STRING(500), allowNull: true },
          next_attempt_at: now,
          created_at: now,
          updated_at: now,
        },
        { transaction }
      );
      await queryInterface.addIndex('domain_provider_deletions', ['provider', 'provider_ref'], {
        unique: true,
        name: 'domain_provider_deletions_ref_unique',
        transaction,
      });
      await queryInterface.addIndex('domain_provider_deletions', ['next_attempt_at'], {
        name: 'domain_provider_deletions_next_idx',
        transaction,
      });
      await queryInterface.addColumn('domains', 'ssl_detail', { type: DataTypes.STRING(300), allowNull: true }, { transaction });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('domains', 'ssl_detail');
    await queryInterface.dropTable('domain_provider_deletions');
  },
};
