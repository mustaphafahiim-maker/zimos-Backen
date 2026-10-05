'use strict';

module.exports = (sequelize, DataTypes) => {
  const AdSpendDaily = sequelize.define(
    'AdSpendDaily',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      day: { type: DataTypes.DATEONLY, allowNull: false },
      // meta | tiktok | snapchat | google | other
      platform: { type: DataTypes.STRING(30), allowNull: false },
      campaignName: { type: DataTypes.STRING(200), allowNull: false, field: 'campaign_name' },
      // Lower-cased, trimmed name: what utm_campaign is matched against.
      campaignKey: { type: DataTypes.STRING(200), allowNull: false, field: 'campaign_key' },
      campaignId: { type: DataTypes.STRING(100), allowNull: true, field: 'campaign_id' },
      // The ads behind it, from an ad-level import (profit/adIdMatching.js).
      adIds: { type: DataTypes.JSONB, allowNull: true, field: 'ad_ids' },
      spendAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'spend_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      impressions: { type: DataTypes.INTEGER, allowNull: true },
      clicks: { type: DataTypes.INTEGER, allowNull: true },
      // manual | csv | sync
      source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'ad_spend_daily' }
  );
  return AdSpendDaily;
};
