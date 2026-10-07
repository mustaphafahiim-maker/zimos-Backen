'use strict';

module.exports = (sequelize, DataTypes) => {
  const Domain = sequelize.define(
    'Domain',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: false, field: 'website_id' },
      // Unique only among verified and active rows (migration 211): an unverified claim never blocks the owner.
      hostname: { type: DataTypes.STRING(255), allowNull: false },
      verificationToken: { type: DataTypes.STRING(100), allowNull: false, field: 'verification_token' },
      status: {
        type: DataTypes.ENUM('pending_verification', 'verified', 'active', 'failed'),
        allowNull: false,
        defaultValue: 'pending_verification',
      },
      isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_primary' },
      verifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'verified_at' },
      // Certificate state through a provider, and the funnel on the domain's root
      // (modules/domains/domainSettings.js).
      sslStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'none', field: 'ssl_status' },
      sslProvider: { type: DataTypes.STRING(40), allowNull: true, field: 'ssl_provider' },
      sslProviderRef: { type: DataTypes.STRING(200), allowNull: true, field: 'ssl_provider_ref' },
      sslCheckedAt: { type: DataTypes.DATE, allowNull: true, field: 'ssl_checked_at' },
      // The provider's reason when the certificate failed (migration 212).
      sslDetail: { type: DataTypes.STRING(300), allowNull: true, field: 'ssl_detail' },
      // When the provider was first asked (migration 505): the job's 72 hours count from it.
      sslRequestedAt: { type: DataTypes.DATE, allowNull: true, field: 'ssl_requested_at' },
      // Set by the domains job (migration 213, domains/domainJobs.js): plan = not served at all;
      // store_suspended = only the store's "unavailable" page (423), as for any suspended store.
      suspendedAt: { type: DataTypes.DATE, allowNull: true, field: 'suspended_at' },
      suspendedReason: { type: DataTypes.STRING(20), allowNull: true, field: 'suspended_reason' },
      homeFunnelId: { type: DataTypes.UUID, allowNull: true, field: 'home_funnel_id' },
      // Its www / root counterpart sent to it (migration 435, domains/rootDomains.js).
      counterpart: { type: DataTypes.JSONB, allowNull: true },
      // Send visits on this domain to the store's primary one (migration 458); false serves the store here.
      redirectToPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'redirect_to_primary' },
    },
    {
      tableName: 'domains',
      indexes: [
        { unique: true, fields: ['hostname'], where: { status: ['verified', 'active'] } },
        { fields: ['hostname'] },
        { fields: ['website_id'] },
      ],
    }
  );
  Domain.associate = (models) => {
    Domain.belongsTo(models.Website, { foreignKey: 'websiteId', as: 'website' });
  };
  return Domain;
};
