# Exchange-rate adapters — the contract

ZIMOS keeps exchange rates in `fx_rates` (`base`, `quote`, `rate` numeric(18,8),
`fetched_at`): 1 unit of `base` = `rate` units of `quote`. The table is filled
once a day by the `fx.refresh` job (`../fxJob.js`) through a **rates adapter**.

Two adapters exist:
- `exchangerateapi` (`exchangeRateApiAdapter.js`), the real one: ExchangeRate-API, daily market rates.
  With `EXCHANGERATE_API_KEY` it uses the keyed v6 endpoint. Without a key it uses the open endpoint
  (open.er-api.com), which is free and asks for attribution where rates are shown. It is the
  default in production.
- `sandbox`: a fixed table of placeholder numbers with no network, **not market rates**. It is the
  default outside production and refused in production (the job then keeps the rates it has).

## The interface

```js
module.exports = {
  code: 'openexchangerates',

  // Every ISO 4217 code this provider can quote.
  currencies() => string[],

  // Rates for one base currency. rates[quote] = units of quote per 1 base.
  // Throws on a network or auth failure — the job keeps yesterday's rows.
  async fetchRates({ base }) => { base, fetchedAt: Date, rates: { [quote]: number } },
};
```

Register it in `adapters/index.js` and select it with `FX_RATES_PROVIDER=<code>`
(default: `exchangerateapi` in production, `sandbox` elsewhere). The provider's API key is platform configuration (an
environment variable), not a merchant secret.

## How rates are used

- **Conversion** is `core/utils/money.js#convertAmount(amount, rate)`: integer
  minor units in, integer minor units out, rounded half-up. Currencies with a
  different number of decimals are handled by `fxService.convert`, which scales
  by each currency's minor-unit digits first.
- **Orders** store `fx_rate_to_base` and `total_amount_base` when they are
  placed (`fxService.baseFieldsFor`), so a later rate change never rewrites
  history. An order in the store's own currency has rate 1.
- **Display currencies** (`workspace.settings.currencies`): the storefront may
  show prices converted for the visitor (`GET /store/:ws/currencies`), but the
  order is always created and collected in the store's (or funnel's) currency.
- **Analytics** accept `?currency=` and convert the store-currency totals with
  today's rate — a presentation choice, not accounting.

## The job

`fx.refresh` runs at start-up when the table is empty or stale, then every 24
hours. It refreshes one base (`USD`) and every other pair is derived through it
(`rate(A→B) = rate(USD→B) / rate(USD→A)`), so the table stays small. A failed
refresh is logged and the previous rates stay in place; `fetched_at` shows how
old they are. `POST /workspaces/:id/currencies/refresh` runs it on demand.
