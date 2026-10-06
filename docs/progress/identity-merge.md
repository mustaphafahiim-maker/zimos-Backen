# Identity merge — 2026-10-05

GitHub's work (`claude/gracious-cori-p3g4hr`, both repos) merged with the
visual identity built locally in the `ui-foundation` workspace. Pushed to
`zimos-latest` in each repo; the local state before the merge is on
`backup/local-identity`. Merges only — no rebase, reset or force-push; `main`
and `master` were not touched.

## Backend

- Nothing local to keep: the local branch was an older state of the same
  GitHub branch. Fast-forwarded to it (174 commits).
- Migrations run on the local database up to `433-funnel-session-opt-ins`.
- `npm install` was not run: this machine has no registry access, and an
  earlier `npm ci` wiped `node_modules` when it failed. The packages added
  earlier (`@sentry/node`, `bullmq`, `ioredis`, `rate-limit-redis`) are not
  installed locally. They are loaded only when Sentry or Redis is configured,
  so the server starts and runs without them here. **On a machine with
  network access, run `npm ci` before deploying.**

## Frontend — what was taken from where

Frontend commit: `f2416534380b6bda8b28a80a256806bd196cefde`.

- **From GitHub (function and data):** everything in `packages/api-client`,
  hooks, page logic, validation, forms and their steps, the new workspace
  package `@store-builder/error-reporter`, and every new screen and
  component. 105 commits; all but one file merged without conflict.
- **From the local side (look and identity):** the Glass dashboard frame and
  backdrop, the palette (navy text, Product Blue, cool light surface), the
  new three-module Z logo, the top bar (breadcrumb, search, store link,
  alerts, account menu), keyboard shortcuts, full-screen mode, the home
  shortcuts and site analytics, the Glass sign-in pages, the comfort layer,
  the affiliates flow, the funnels list actions and the funnel editor's
  two-row top bar, the store-settings live preview, the marketing landing
  page section and copy.
- **The one conflict — `DashboardHomePage.tsx`:** kept the local shortcuts and
  site analytics, and added GitHub's new `HelpCards` under them. The three
  generic link cards (orders / products / customers) stay out: the shortcuts
  replaced them.
- **`FunnelEditorPage.tsx`, `FunnelsPage.tsx`, `RegisterPage.tsx`, `main.tsx`:**
  changed on both sides, merged by git with no conflict; both sides' changes
  are present.

## Decisions on the look

- **New components from GitHub** (`TwoFactorStep`, `BackupCodesPanel`,
  `TrustStrip`, `RichFooter`, `CodSwitch`, `FunnelOptIn`, `TrackOrder`,
  unsubscribe page, console `TwoFactorForm`) are written with the semantic
  tokens, so in the dashboard they take the new palette and the Glass cards
  and buttons with no edit. They were not restyled one by one.
- **Logo:** the dashboard, marketing site, console and storefront all draw
  the new Z and wordmark. In the console and the storefront it keeps the
  brand's own blue and navy, because those apps have their own primary
  colour (the console's teal, a store's merchant colours).
- **Console palette left as it is** (teal). It was not part of the identity
  work, and its different colour tells an operator at a glance that they are
  in the console, not a merchant's dashboard.
- **Storefront palette left as it is.** A store's colours belong to the
  merchant's theme; only the "Powered by ZIMOS" logo changed.

## Checked, and not checked

- Typecheck passes: merchant-dashboard, platform-admin, storefront, marketing.
- Opened on localhost after the merge, signed in with the seed account, in
  Arabic at desktop width: home, orders, automations, subscriptions,
  settings, funnels, affiliates; store home, track order and cart. No page
  errors and no 5xx responses.
- **Not opened:** the console sign-in, a product page, checkout, payment, a
  funnel page in the store, Settings > Security, English, and phone width
  after this merge. The two-factor and backup-code screens were not
  exercised.
- No test suites were run or written (lane contract).
