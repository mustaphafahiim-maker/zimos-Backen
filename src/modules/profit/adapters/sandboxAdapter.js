'use strict';

/**
 * The `sandbox` ads adapter: the contract of adapters/README.md with no
 * network behind it. It reports no spend, so the hourly sync runs end to end
 * and writes nothing. A real adapter (Meta, TikTok, Snapchat) is the
 * integrations team's work and replaces this file per platform.
 */
module.exports = {
  code: 'sandbox',

  describe() {
    return { code: 'sandbox', name: 'Sandbox', platforms: ['meta', 'tiktok', 'snapchat', 'google'], supportsOAuth: false };
  },

  /** @returns {Promise<{ok: boolean, accountName?: string, error?: string}>} */
  async validateCredentials() {
    return { ok: true, accountName: 'Sandbox ad account' };
  },

  /**
   * @param {{ config: object, secrets: object|null, from: string, to: string }} args   from/to are YYYY-MM-DD, inclusive
   * @returns {Promise<Array<{day: string, platform: string, campaignId?: string, campaignName: string,
   *                          spendAmount: number, impressions?: number, clicks?: number}>>}
   */
  async fetchDailySpend() {
    return [];
  },

  // Item 261: the ad accounts behind the credentials, for the merchant to pick from.
  /** @returns {Promise<Array<{accountId: string, name: string, platform: string, currency?: string}>>} */
  async listAdAccounts() {
    return [
      { accountId: 'sbx_meta_1', name: 'Sandbox Meta account', platform: 'meta', currency: 'EGP' },
      { accountId: 'sbx_tiktok_1', name: 'Sandbox TikTok account', platform: 'tiktok', currency: 'EGP' },
    ];
  },

  // Item 261 (SPEC §15.4, P2): pause / resume a campaign and change its daily budget.
  // The sandbox changes nothing anywhere and answers as the platform would.
  /** @returns {Promise<{ok: boolean, status?: string, error?: string}>} */
  async setCampaignStatus({ accountId, campaignId, status }) {
    require('../../../core/utils/logger').info('[ads sandbox] campaign status not sent', { accountId, campaignId, status });
    return { ok: true, status };
  },

  /** dailyBudgetAmount: integer minor units of the ad account's currency. */
  async setCampaignBudget({ accountId, campaignId, dailyBudgetAmount }) {
    require('../../../core/utils/logger').info('[ads sandbox] campaign budget not sent', { accountId, campaignId, dailyBudgetAmount });
    return { ok: true, dailyBudgetAmount };
  },
};
