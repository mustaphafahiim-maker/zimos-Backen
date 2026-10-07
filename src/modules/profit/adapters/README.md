# Ads adapters — the contract

ZIMOS records advertising spend per day, platform and campaign in
`ad_spend_daily`. Merchants can type it in or import a CSV today. An **ads
adapter** fills the same table automatically from an ad platform.

Only the `sandbox` adapter exists. OAuth with Meta / TikTok / Snapchat and the
real spend pull are out of scope here (SPEC §15.4) and belong to the
integrations team; this file is what they implement against.

## Where a connection lives

One `WorkspaceIntegration` row per connected ad account:

| column | value |
|---|---|
| `provider` | `ads:<adapter code>` (e.g. `ads:meta`) |
| `status` | `connected` \| `error` \| `disconnected` |
| `config` | non-secret settings: `{ accountId, accountName, platform }` |
| `secretsSealed` | tokens, sealed with `core/utils/secretBox.js` — never returned by any endpoint |

## The interface

```js
module.exports = {
  code: 'meta',

  // Static description, used to render the connect form.
  describe() => ({ code, name, platforms: string[], supportsOAuth: boolean }),

  // Called when the merchant connects. Never throws for bad credentials.
  async validateCredentials({ config, secrets }) => ({ ok, accountName?, error? }),

  // Spend per campaign per day for an inclusive date range (YYYY-MM-DD, in the
  // ad account's time zone). Amounts are integer minor units of the store's
  // currency. Must be idempotent: the same range returns the same rows.
  async fetchDailySpend({ config, secrets, from, to }) => [
    { day, platform, campaignId?, campaignName, spendAmount, impressions?, clicks? },
  ],
};
```

Register the adapter in `adapters/index.js`.

## The sync job

`adsSyncJob.js` (`ads.sync_spend`) runs hourly in the API process. For every
`ads:*` integration with status `connected` it calls `fetchDailySpend` for the
last 3 days and upserts the rows with `source = 'sync'` — one row per
(day, platform, campaign), so re-running never doubles spend. A failure is
written to the integration's `lastError` and does not stop the other accounts.
`POST /workspaces/:id/profit/ads/sync` runs it for one store on demand.

## Matching spend to orders

Orders are matched to a campaign when the `utm_campaign` of the visit equals
the campaign's **name or id** (case-insensitive). The campaigns report returns
ready-made URL parameters per platform (`suggestedUrlParameters`) for the
merchant to paste into the ads manager.

## Ad accounts and campaign controls (item 261)

The merchant connects an adapter with its credentials and then **picks the ad
accounts** to follow (`/profit/ads/connections`, adAccounts.js). The picked
ids are in `config.selectedAccountIds`; `fetchDailySpend` must pull those
accounts only. Three more methods:

```js
  // Every ad account the credentials reach.
  async listAdAccounts({ config, secrets }) => [{ accountId, name, platform, currency? }],

  // SPEC §15.4 (P2): pause or resume a campaign; status is 'paused' | 'active'.
  async setCampaignStatus({ config, secrets, accountId, campaignId, status }) => ({ ok, status?, error? }),

  // The campaign's daily budget, in minor units of the ad account's currency.
  async setCampaignBudget({ config, secrets, accountId, campaignId, dailyBudgetAmount }) => ({ ok, dailyBudgetAmount?, error? }),
```

`ok: false` with `error` for a refusal by the platform (the change is not
recorded); a thrown error means the platform could not be reached. The last
status and budget set from ZIMOS are kept in `config.campaigns` so the
campaigns screen can show them; the platform stays the source of truth.
