# captcha — invisible challenge verifier contract

The checkout guard (`modules/risk/botProtection.js`) has three checks: a
honeypot field, a server-signed time token, and — when a store switches it on
and a provider is configured — an invisible challenge such as Cloudflare
Turnstile. The first two need nothing from outside. This folder is the
interface for the third, with a `sandbox` verifier. The real verifier is the
integrations team's work.

## The verifier

```js
module.exports = {
  name: 'turnstile',                     // the value of CAPTCHA_PROVIDER that selects it
  siteKey() { return process.env.TURNSTILE_SITE_KEY; },   // public; sent to the storefront
  async verify(token, ip) {              // token: what the widget produced; ip: shopper IP or null
    return { success: true };            // or false / { success: false }
  },
};
```

Register it once at start-up and set `CAPTCHA_PROVIDER=turnstile`:

```js
require('./modules/risk/captcha').registerVerifier(require('./turnstileVerifier'));
```

## Rules

- `verify` has 3000 ms. A throw, a rejection or a timeout counts as a **pass**
  and is logged: a provider outage must not stop every checkout. A definite
  "no" from the provider is the only thing that fails a shopper.
- A missing token is a fail (the widget did not run).
- The secret key stays in the environment, read inside the verifier. Only
  `siteKey()` reaches the browser.
- A failed challenge is answered like any refused order (`ORDER_REJECTED`)
  and filed under Lost orders with reason `integrity_check`.

## What the storefront gets

`GET /store/:workspaceId/checkout/guard` →

```json
{ "enabled": true, "token": "…", "minSeconds": 3, "honeypotField": "website",
  "captcha": { "provider": "turnstile", "siteKey": "…" } }
```

`captcha` is null when no verifier is active or the store has not switched the
challenge on (`settings.fraud_rules.bot_captcha`). The storefront sends the
widget's token as `captchaToken` in the checkout body.

## The sandbox verifier

`CAPTCHA_PROVIDER=sandbox` (refused in production). Token `sandbox-pass`
passes; anything else fails. Site key `sandbox-site-key`.
