# Going live — what to set in production

Every integration in ZIMOS has a real adapter and a `sandbox` one. With `NODE_ENV=production`
the real one is used once its keys are set; the sandbox is never used silently. Production
either refuses to start, or answers the feature with a clear "not available yet" (503) until
the keys are there. Names only are listed in `.env.example`; each module's README has the setup.

## 1. Required — the API refuses to start without these

| Setting | Notes |
|---|---|
| `NODE_ENV=production` | |
| `DATABASE_URL` or `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` | No fallback password. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY` | 32+ characters each, not placeholders (`openssl rand -hex 32`). |
| `GATEWAY_CREDENTIALS_KEY`, `CARRIER_CREDENTIALS_KEY` | Seal the gateway and courier credentials merchants save. |
| `STORAGE_PROVIDER=r2` + `R2_*` | Uploaded images and files. |
| `EMAIL_PROVIDER=brevo` + `BREVO_API_KEY` | Sign-up codes, password resets, order emails. Refuses `console`. |
| `APP_URL`, `PLATFORM_ROOT_DOMAIN`, `PLATFORM_APEX_IPS` | Links in emails; store subdomains; A records for root domains. |

## 2. Sign-up

- `REQUIRE_SIGNUP_VERIFICATION=true`: a new account enters a 6-digit code (email or phone)
  before it gets in. The dashboard's code screen (`VerifyCodePanel`) already handles it.
- `SIGNUP_CONFIRM_BY_CODE`: leave **off**. It is Ziad's alternative to the line above (sign in
  first, confirm later), not an addition. It needs its own dashboard screen (handoff 330).
- `REQUIRE_PLAN_AT_SIGNUP`, `REQUIRE_SUBSCRIPTION_TO_GO_LIVE`, `REQUIRE_PHONE_AT_SIGNUP`: business
  choices. The dashboard handles all three.

## 3. Integrations — set the keys to switch each one on

| Feature | Settings | Without them in production |
|---|---|---|
| SMS (checkout codes, messages) | `SMS_PROVIDER=twilio`, `TWILIO_*` | Logged only; a warning at start. |
| ZIMOS's WhatsApp codes | `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_PLATFORM_*` | Logged only; a warning at start. |
| Store email domains | `BREVO_API_KEY` (`EMAIL_DOMAIN_PROVIDER=brevo`) | 503 `EMAIL_DOMAIN_UNAVAILABLE`. |
| Delivery status of emails/SMS | `BREVO_WEBHOOK_TOKEN`, `TWILIO_AUTH_TOKEN`, `NOTIFICATIONS_WEBHOOK_BASE_URL` | No delivered/bounced statuses. |
| Exchange rates | none needed (`exchangerateapi` open endpoint); `EXCHANGERATE_API_KEY` optional | Real rates by default. |
| Online card payments | `PAYMENTS_ONLINE_ENABLED=true`; each merchant connects Stripe / Paymob / Kashier / PayPal | Cash on delivery only. |
| Couriers | `CARRIERS_ENABLED=bosta,mylerz,jtexpress`; merchants connect their accounts | Manual shipping. |
| Buying domains | `DOMAIN_REGISTRAR=dynadot` + `DYNADOT_API_KEY` (or Namecheap), `DOMAIN_SELL_CURRENCY`, `DOMAIN_MARGIN_PERCENT`, `DOMAIN_PRICE_STEP` | 503 "connect a domain you own". |
| Custom domain certificates | `CERTIFICATE_PROVIDER=cloudflare`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | Domains can't be served over HTTPS. |
| Tracking manual waybills | `AFTERSHIP_API_KEY` (store setting `tracking_provider`) | Off. |
| Browser notifications | `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` (`node scripts/generate-vapid-keys.js`) | Off. |
| Google Sheets | `GOOGLE_SHEETS_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI` | 503. |
| AI features | `ANTHROPIC_API_KEY` (`AI_PROVIDER=anthropic`, optional `AI_MODEL`) | 503. |
| Address autocomplete | Each merchant enters their own Google Places key | Typed addresses only. |
| Server events (Meta, TikTok, Snap, Google, X, Reddit, Microsoft, Pinterest) | Each merchant's pixel token | Live by default; nothing sent for a pixel without a token. |
| Subscription billing | Fawaterak keys (Ziad's, `docs/billing-payment-methods.md`) | Manual payment methods only. |
| Prepaid wallet | `WALLET_ENABLED=true` (Ziad's, `docs/billing-wallet.md`) | Off. |

Not available in production on purpose: importing reviews from another site
(`REVIEW_IMPORT_PROVIDER` has no real importer) and the IP-intelligence sandbox.

## 4. Before merchants rely on a new integration

Several adapters were built from the provider's documentation and tested against local
stand-ins only, because the provider's site could not be reached from where they were built.
Each one's README ends with a go-live checklist. Run it once on the provider's own test account:
Dynadot/Namecheap, Brevo (domains and webhooks), Twilio webhooks, Meta template submission,
Paymob and PayPal saved cards, PayPal payouts, Bosta and Mylerz return pickups, AfterShip,
Google Sheets.

## 5. Checks that run on every push (CI)

`node scripts/ci-check.js` (every file parses, the app loads, OpenAPI is current, every table is
classified for the launch reset). Then every migration on an empty PostgreSQL, the newest one
rolled back and applied again, and the demo seed.
