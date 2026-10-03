'use strict';

/**
 * domains: the certificate's state and the funnel a domain opens on
 * (SPEC §8.11).
 *
 *   ssl_status       none | pending | issued | failed — kept in step with the
 *                    certificate provider (modules/domains/certificates)
 *   ssl_provider     which provider adapter issued / is issuing it
 *   ssl_provider_ref the provider's own id for the certificate request
 *   ssl_checked_at   when the provider was last asked
 *   home_funnel_id   the funnel shown on the domain's root instead of the
 *                    store's home page; cleared if the funnel is deleted
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('domains', 'ssl_status', {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'none',
    });
    await queryInterface.addColumn('domains', 'ssl_provider', { type: DataTypes.STRING(40), allowNull: true });
    await queryInterface.addColumn('domains', 'ssl_provider_ref', { type: DataTypes.STRING(200), allowNull: true });
    await queryInterface.addColumn('domains', 'ssl_checked_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('domains', 'home_funnel_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'funnels', key: 'id' },
      onDelete: 'SET NULL',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('domains', 'home_funnel_id');
    await queryInterface.removeColumn('domains', 'ssl_checked_at');
    await queryInterface.removeColumn('domains', 'ssl_provider_ref');
    await queryInterface.removeColumn('domains', 'ssl_provider');
    await queryInterface.removeColumn('domains', 'ssl_status');
  },
};
