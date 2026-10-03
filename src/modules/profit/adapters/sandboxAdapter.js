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
};
