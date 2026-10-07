'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      email: {
        type: DataTypes.CITEXT,
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
      },
      passwordHash: { type: DataTypes.STRING, allowNull: true, field: 'password_hash' },
      googleId: { type: DataTypes.STRING(64), allowNull: true, unique: true, field: 'google_id' },
      fullName: { type: DataTypes.STRING(200), allowNull: false, field: 'full_name' },
      // A public image URL (migration 409, auth/profileRoutes.js).
      avatarUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'avatar_url' },
      // The dashboard language the teammate uses ('ar' / 'en'): their notifications are written in it (migration 439).
      locale: { type: DataTypes.STRING(5), allowNull: true },
      // Public handle, always lower-case, unique regardless of case (migration
      // 124; rules in modules/users/username.js). Null only for an account made
      // through Google until its owner picks one.
      username: { type: DataTypes.STRING(30), allowNull: true },
      // The last time its owner changed it (not the first choice).
      usernameChangedAt: { type: DataTypes.DATE, allowNull: true, field: 'username_changed_at' },
      phone: { type: DataTypes.STRING(32), allowNull: true },
      status: {
        type: DataTypes.ENUM('active', 'suspended', 'pending_verification'),
        allowNull: false,
        defaultValue: 'pending_verification',
      },
      // Suspended or deleted from the console (migration 204,
      // platformAdmin/userModerationService). Both set status 'suspended'.
      suspendedAt: { type: DataTypes.DATE, allowNull: true, field: 'suspended_at' },
      suspendedReason: { type: DataTypes.STRING(500), allowNull: true, field: 'suspended_reason' },
      deletedAt: { type: DataTypes.DATE, allowNull: true, field: 'deleted_at' },
      emailVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'email_verified_at' },
      phoneVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'phone_verified_at' },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
      // The plan chosen at sign-up (migration 126), applied to the first store.
      selectedPlanId: { type: DataTypes.UUID, allowNull: true, field: 'selected_plan_id' },
      selectedBillingCycle: { type: DataTypes.STRING(10), allowNull: true, field: 'selected_billing_cycle' },
      // A Google account made while a plan was required: it picks one before
      // anything else (auth/signupPolicy). False for every earlier account.
      requiresPlanSelection: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'requires_plan_selection' },
      termsAcceptedAt: { type: DataTypes.DATE, allowNull: true, field: 'terms_accepted_at' },
      termsVersion: { type: DataTypes.STRING(40), allowNull: true, field: 'terms_version' },
      // Platform-console access (migration 105). NULL role = no access. The
      // permission set is what every /admin route checks; the role is the
      // label and the template it was seeded from.
      platformRole: { type: DataTypes.STRING(64), allowNull: true, field: 'platform_role' },
      platformPermissions: {
        type: DataTypes.ARRAY(DataTypes.STRING(64)),
        allowNull: false,
        defaultValue: [],
        field: 'platform_permissions',
      },
      // Read-only, for clients that predate roles: "may sign in to the
      // platform console". Derived from the role; the old users.platform_admin
      // column is no longer read.
      platformAdmin: {
        type: DataTypes.VIRTUAL,
        get() {
          return this.getDataValue('platformRole') != null;
        },
        set() {
          throw new Error('platformAdmin is derived from platformRole; set platformRole instead');
        },
      },
    },
    {
      tableName: 'users',
      indexes: [{ unique: true, fields: ['email'] }],
    }
  );

  User.associate = (models) => {
    User.hasMany(models.Membership, { foreignKey: 'userId', as: 'memberships' });
    User.hasMany(models.Session, { foreignKey: 'userId', as: 'sessions' });
    User.hasMany(models.Workspace, { foreignKey: 'ownerUserId', as: 'ownedWorkspaces' });
  };

  // Never serialize the password hash.
  User.prototype.toSafeJSON = function toSafeJSON() {
    const { passwordHash, ...rest } = this.toJSON();
    return rest;
  };

  return User;
};
