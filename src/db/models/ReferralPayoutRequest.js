'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant asking to be paid their referral earnings (referrals/merchantReferrals.js).
  const ReferralPayoutRequest = sequelize.define(
    'ReferralPayoutRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      amounts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      method: { type: DataTypes.STRING(20), allowNull: false },
      details: { type: DataTypes.STRING(300), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'requested' },
      note: { type: DataTypes.STRING(500), allowNull: true },
      handledBy: { type: DataTypes.UUID, allowNull: true, field: 'handled_by' },
      handledAt: { type: DataTypes.DATE, allowNull: true, field: 'handled_at' },
    },
    { tableName: 'referral_payout_requests' }
  );
  return ReferralPayoutRequest;
};
