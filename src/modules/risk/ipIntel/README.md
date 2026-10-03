# ipIntel — IP reputation adapter contract

ZIMOS asks one question about a shopper's IP address: which country it is in,
and whether it is a VPN or a hosting provider. The answer feeds the fraud
rules (`block_outside_country`, `block_vpn`), the visitor block
(`blocked_countries`), the order's `ipCountry` and the risk score.

The real provider is the integrations team's work. This folder holds the
interface (`index.js`) and a `sandbox` adapter with fixed answers.

## The adapter

```js
module.exports = {
  name: 'acme',                 // the value of IP_INTEL_PROVIDER that selects it
  async lookup(ip) {            // ip: a bare IPv4 or IPv6 string, already validated
    return {
      country: 'EG',            // ISO 3166-1 alpha-2, or null when unknown
      isVpn: false,             // VPN, proxy or Tor exit
      isHosting: false,         // data centre / hosting provider range
    };
  },
};
```

Register it once at start-up:

```js
require('./modules/risk/ipIntel').registerAdapter(require('./acmeAdapter'));
```

and set `IP_INTEL_PROVIDER=acme`.

## Rules for an adapter

- `lookup` may throw or reject on any failure. The interface catches it, logs
  a warning and treats the IP as unknown. An order is never refused because
  the provider is down.
- It has 1500 ms. Slower answers count as unknown.
- Results are cached in memory for 10 minutes per IP (5000 entries), so one
  page view does not cost several provider calls. Do not cache again.
- Unknown is `{ country: null, isVpn: false, isHosting: false }`. Never guess
  a country.
- Keep credentials in environment variables read inside the adapter. Nothing
  about the provider is stored per store.

## What callers get

`ipIntel.lookup(ip)` always resolves to `{ country, isVpn, isHosting }` with
`country` upper-cased or null. `ipIntel.providerName()` is the active
adapter's name, or null when none is configured.

## Which adapter answers

| `IP_INTEL_PROVIDER` | `NODE_ENV` | Adapter |
|---|---|---|
| unset | not production | `sandbox` |
| unset | production | none — every lookup is unknown |
| `sandbox` | production | none, unless `IP_INTEL_ALLOW_SANDBOX=true` |
| a registered name | any | that adapter |

## The sandbox adapter

No network. The RFC 5737 documentation ranges stand for the interesting cases:

| IP | Answer |
|---|---|
| `203.0.113.x` | US, VPN |
| `198.51.100.x` | SA |
| `192.0.2.x` | DE, hosting |
| anything else | EG |

Locally, send `X-Forwarded-For: 203.0.113.7` to the API to order "from" one
of them (the app trusts one proxy hop).
