'use strict';

require('dotenv').config();

const { parseDbUrl } = require('./parseDbUrl');

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    // Fail fast at boot rather than deep inside a request handler.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// A single DATABASE_URL (Railway / Heroku) wins over the separate DB_* vars,
// except under NODE_ENV=test — tests always use the dedicated test database
// so a deploy's DATABASE_URL can never point them at a live one.
const dbUrl = process.env.NODE_ENV === 'test' ? null : parseDbUrl(process.env.DATABASE_URL);

// Checked at boot so a weak value fails the deploy instead of quietly letting
// anyone who guesses it choose their own storefront rate-limit key.
const storefrontProxySecret = (process.env.STOREFRONT_PROXY_SECRET || '').trim();
if (storefrontProxySecret && storefrontProxySecret.length < 32) {
  throw new Error('STOREFRONT_PROXY_SECRET must be at least 32 characters (generate one with `openssl rand -hex 32`)');
}

// A comma-separated env var as a list of lower-cased, trimmed entries. Unset
// uses the fallback; set but empty is an empty list. Under NODE_ENV=test the
// fallback always wins, so a dev .env can't change what the suite sees.
function csvList(raw, fallback) {
  const value = raw === undefined || process.env.NODE_ENV === 'test' ? fallback : raw;
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  port: parseInt(process.env.PORT || '4000', 10),
  appUrl: process.env.APP_URL || 'http://localhost:4000',
  apiVersion: process.env.API_VERSION || 'v1',
  platformRootDomain: process.env.PLATFORM_ROOT_DOMAIN || 'zimos.test',

  db: {
    url: process.env.DATABASE_URL || null,
    host: (dbUrl && dbUrl.host) || process.env.DB_HOST || 'localhost',
    port: (dbUrl && dbUrl.port) || parseInt(process.env.DB_PORT || '5432', 10),
    name:
      process.env.NODE_ENV === 'test'
        ? process.env.DB_NAME_TEST || 'zimos_test'
        : (dbUrl && dbUrl.name) || required('DB_NAME', 'zimos_dev'),
    user: (dbUrl && dbUrl.user) || process.env.DB_USER || 'postgres',
    password: (dbUrl && dbUrl.password) || process.env.DB_PASSWORD || 'postgres',
    ssl: dbUrl ? dbUrl.ssl || process.env.DB_SSL === 'true' : process.env.DB_SSL === 'true',
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
    poolMin: parseInt(process.env.DB_POOL_MIN || '0', 10),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev_only_access_secret_change_me_32chars'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev_only_refresh_secret_change_me_32chars'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/v1/auth/google/callback',
  },

  // Where the Google callback sends the browser (with tokens in the query).
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
    // Public storefront API only (see core/middleware/rateLimiters.js). Each
    // shopper still gets `max`; these are the ceilings per connecting IP — for
    // everyone sharing one IP (NAT, rotating cart tokens), and for our own
    // storefront server, which fetches on behalf of every shopper.
    storefrontIpMax: parseInt(process.env.STOREFRONT_IP_RATE_LIMIT_MAX || '500', 10),
    storefrontServerMax: parseInt(process.env.STOREFRONT_SERVER_RATE_LIMIT_MAX || '5000', 10),
    // Public order-tracking lookup only (GET /store/:id/orders/track). Keyed on
    // the shopper's phone, not their IP: `trackingMax` is per phone + order
    // number, `trackingPhoneMax` is the ceiling per phone across all the order
    // numbers tried with it. See core/middleware/rateLimiters.js.
    trackingWindowMs: parseInt(process.env.TRACKING_RATE_LIMIT_WINDOW_MS || '600000', 10),
    trackingMax: parseInt(process.env.TRACKING_RATE_LIMIT_MAX || '3', 10),
    trackingPhoneMax: parseInt(process.env.TRACKING_PHONE_RATE_LIMIT_MAX || '30', 10),
    // Storefront search suggestions (GET /store/:id/products/suggest), per
    // shopper: a minute and an hour. See core/middleware/rateLimiters.js.
    suggestMinuteMax: parseInt(process.env.SUGGEST_RATE_LIMIT_PER_MINUTE || '60', 10),
    suggestHourMax: parseInt(process.env.SUGGEST_RATE_LIMIT_PER_HOUR || '1200', 10),
    // "Is this username free?" (GET /auth/username-available), per IP: tight,
    // so the endpoint cannot be used to list who has an account.
    usernameCheckMinuteMax: parseInt(process.env.USERNAME_CHECK_RATE_LIMIT_PER_MINUTE || '20', 10),
    usernameCheckHourMax: parseInt(process.env.USERNAME_CHECK_RATE_LIMIT_PER_HOUR || '200', 10),
    // The public plan list (GET /plans/public), per IP per minute.
    publicPlansMinuteMax: parseInt(process.env.PUBLIC_PLANS_RATE_LIMIT_PER_MINUTE || '60', 10),
    // Sign-up codes (POST /auth/verify/send and /confirm), per IP per minute —
    // on top of the per-address and per-account limits kept in the database
    // (otp/verificationCodeService).
    verifyMinuteMax: parseInt(process.env.VERIFY_RATE_LIMIT_PER_MINUTE || '10', 10),
  },

  // How the backend recognises our own Next.js storefront server. The secret is
  // sent server-to-server only (never to a browser); a request carrying it may
  // forward the shopper's IP for rate limiting. STOREFRONT_SERVER_IP
  // (comma-separated IPs or CIDR ranges) only raises that IP's limit — it never
  // makes a forwarded shopper IP trusted on its own.
  storefrontProxy: {
    secret: storefrontProxySecret,
    serverIps: (process.env.STOREFRONT_SERVER_IP || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Under NODE_ENV=test email and SMS are pinned to `console` (as storage is
  // pinned to `local` below) so a dev .env with EMAIL_PROVIDER=brevo or
  // SMS_PROVIDER=twilio can't make the suite send real mail/SMS. A test that
  // wants a real adapter sets env.notifications.*Provider at runtime.
  notifications: {
    emailProvider: process.env.NODE_ENV === 'test' ? 'console' : process.env.EMAIL_PROVIDER || 'console',
    smsProvider: process.env.NODE_ENV === 'test' ? 'console' : process.env.SMS_PROVIDER || 'console',
    whatsappProvider: process.env.WHATSAPP_PROVIDER || 'console',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
    },
    // Brevo transactional email (only used when EMAIL_PROVIDER=brevo).
    brevo: {
      apiKey: process.env.BREVO_API_KEY || '',
      fromAddress: process.env.EMAIL_FROM_ADDRESS || '',
      fromName: process.env.EMAIL_FROM_NAME || 'Zimos',
    },
    // Twilio SMS (only used when SMS_PROVIDER=twilio).
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    },
  },

  // Uploaded-image storage. `local` (default) writes to public/uploads and is
  // fine for local dev; `r2` puts objects in a Cloudflare R2 bucket so images
  // survive a redeploy on an ephemeral filesystem. R2 credentials are only
  // required when STORAGE_PROVIDER=r2. Values are trimmed/lower-cased because
  // dashboard env editors (Railway, etc.) routinely leave a trailing space or
  // newline that would otherwise make "r2 " an unknown provider. Under
  // NODE_ENV=test the provider is pinned to `local` so a stray
  // STORAGE_PROVIDER=r2 in a dev .env can't make the suite hit real R2 (a
  // test that wants r2 sets env.storage.provider at runtime).
  storage: {
    provider:
      process.env.NODE_ENV === 'test'
        ? 'local'
        : (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase(),
    r2: {
      accountId: (process.env.R2_ACCOUNT_ID || '').trim(),
      accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
      secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
      bucketName: (process.env.R2_BUCKET_NAME || '').trim(),
      publicUrl: (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
      // Optional: a bucket with no public access for shoppers' photos. Unset,
      // they go to the media bucket under customer-uploads/ (never linked publicly).
      privateBucketName: (process.env.R2_PRIVATE_BUCKET_NAME || '').trim(),
    },
  },

  // Photos shoppers attach to an order through a product's custom fields
  // (POST /store/:workspaceId/uploads). See modules/customerUploads.
  customerUploads: {
    // Refused before any processing above this (413).
    maxRawBytes: 15 * 1024 * 1024,
    // Photos one visitor may have waiting for an order at once.
    maxPendingPerVisitor: parseInt(process.env.CUSTOMER_UPLOAD_MAX_PENDING || '10', 10),
    // A photo no order took is deleted after this long.
    pendingTtlHours: parseInt(process.env.CUSTOMER_UPLOAD_TTL_HOURS || '48', 10),
    // How often the server sweeps expired photos; 0 turns the in-process sweep
    // off (scripts/sweep-customer-uploads.js still works). Off under tests.
    sweepMinutes:
      process.env.NODE_ENV === 'test' ? 0 : parseInt(process.env.CUSTOMER_UPLOAD_SWEEP_MINUTES || '30', 10),
    // Upload rate limits, per connecting IP and per visitor id.
    ipPerMinute: parseInt(process.env.CUSTOMER_UPLOAD_IP_PER_MINUTE || '20', 10),
    ipPerHour: parseInt(process.env.CUSTOMER_UPLOAD_IP_PER_HOUR || '120', 10),
    visitorPerMinute: parseInt(process.env.CUSTOMER_UPLOAD_VISITOR_PER_MINUTE || '8', 10),
    visitorPerHour: parseInt(process.env.CUSTOMER_UPLOAD_VISITOR_PER_HOUR || '40', 10),
    // Signs the short-lived links the dashboard shows these photos through.
    // Unset: derived from JWT_ACCESS_SECRET, so it is secret either way.
    urlSecret: (process.env.UPLOAD_URL_SECRET || '').trim(),
    urlTtlSeconds: parseInt(process.env.UPLOAD_URL_TTL_SECONDS || '900', 10),
  },

  payments: {
    defaultProvider: process.env.PAYMENTS_DEFAULT_PROVIDER || 'mock',
    // Online (gateway) checkout on the storefront. Off: the storefront and the
    // public API behave exactly as the COD-only store always has. The
    // dashboard may still connect gateway accounts while it is off.
    onlineEnabled: process.env.PAYMENTS_ONLINE_ENABLED === 'true',
    // Encrypts merchants' gateway keys at rest (AES-256-GCM, see
    // core/utils/credentialsCipher.js): 32 bytes, base64. Separate from
    // CARRIER_CREDENTIALS_KEY. Unset or malformed: every gateway feature
    // answers 503 GATEWAYS_NOT_CONFIGURED; the app still boots.
    credentialsKey: (process.env.GATEWAY_CREDENTIALS_KEY || '').trim(),
    // How long an unpaid online order holds its stock before it expires.
    attemptTtlMinutes: Math.max(5, parseInt(process.env.PAYMENT_ATTEMPT_TTL_MINUTES || '30', 10) || 30),
    // How many payment attempts one order may start (first try + retries).
    maxAttemptsPerOrder: Math.max(1, parseInt(process.env.PAYMENT_MAX_ATTEMPTS_PER_ORDER || '5', 10) || 5),
    // POST /webhooks/payments/:code/:token, per token per window.
    webhookRateLimitMax: parseInt(process.env.PAYMENT_WEBHOOK_RATE_LIMIT_MAX || '300', 10),
    // Extra hosts (comma-separated) a shopper may be sent back to after
    // paying, besides the platform's own subdomains and the store's verified
    // custom domains — e.g. the storefront app's own host.
    returnHosts: (process.env.PAYMENT_RETURN_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Where each gateway's API lives. Overridable for a regional account.
    paymobBaseUrl: (process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com').trim().replace(/\/+$/, ''),
    // Kashier: the API host (sessions, inquiry) and the checkout host (refund
    // / void), per mode. A test key only works on the test hosts.
    kashier: {
      testApiUrl: (process.env.KASHIER_TEST_API_URL || 'https://test-api.kashier.io').trim().replace(/\/+$/, ''),
      liveApiUrl: (process.env.KASHIER_LIVE_API_URL || 'https://api.kashier.io').trim().replace(/\/+$/, ''),
      testFepUrl: (process.env.KASHIER_TEST_FEP_URL || 'https://test-fep.kashier.io').trim().replace(/\/+$/, ''),
      liveFepUrl: (process.env.KASHIER_LIVE_FEP_URL || 'https://fep.kashier.io').trim().replace(/\/+$/, ''),
    },
  },

  // Shared secret the billing gateway signs its webhook bodies with
  // (HMAC-SHA256, hex, sent as X-Zimos-Signature). Deliberately has no
  // fallback: with nothing configured every webhook is rejected rather than
  // trusted, so a missing value can never become an open endpoint that lets
  // anyone flip a subscription to `active`. See modules/billing/gatewaySignature.js.
  billing: {
    webhookSecret: (process.env.BILLING_WEBHOOK_SECRET || '').trim(),
    // What an unpaid subscription past its grace day does (see
    // workspaces/workspaceAccessService):
    //   enforce  the storefront shows "unavailable" and new products/funnels
    //            are blocked;
    //   warn     the dashboard still shows the expiry banners, nothing is
    //            restricted.
    // Defaults to `warn` in production until merchants have a way to pay —
    // with `enforce`, every store more than a day past its trial with no
    // recorded payment goes unavailable. Tests always enforce. A manual
    // suspension (workspace status) is enforced either way.
    restrictions:
      process.env.NODE_ENV === 'test'
        ? 'enforce'
        : ['enforce', 'warn'].includes(process.env.BILLING_RESTRICTIONS)
          ? process.env.BILLING_RESTRICTIONS
          : process.env.NODE_ENV === 'production'
            ? 'warn'
            : 'enforce',

    // Paying a subscription charge online through Fawaterak
    // (billing/onlineBillingService). ONLINE_BILLING_ENABLED lets a merchant
    // start a payment; it is off unless set to exactly "true". Webhooks and
    // the sweep settle attempts that already exist whenever the keys are set,
    // flag or not: that money moved. Recording a payment by hand works
    // either way.
    online: {
      enabled: process.env.NODE_ENV !== 'test' && process.env.ONLINE_BILLING_ENABLED === 'true',
    },

    // Zimos's own Fawaterak account (billing/fawaterak). All secrets except
    // `env`, `baseUrl` and `tokenUrl`, none with a fallback. Under
    // NODE_ENV=test nothing here is read from the environment: a test sets
    // fake values on this object at runtime, so a dev .env holding staging
    // keys can never reach the suite.
    //   env           staging | live — picks the documented base URL
    //   baseUrl       optional override of that URL (https)
    //   tokenUrl      optional; default {baseUrl}/oauth/token, same origin only
    //   clientId / clientSecret   the OAuth client (dashboard → Integrations)
    //   hashKey       the dashboard's "HASH API key": the key Fawaterak's
    //                 webhook signatures are made with
    //   webhookToken  ours, random: a path segment of our webhook URLs
    fawaterak: {
      env: process.env.NODE_ENV === 'test' ? 'staging' : (process.env.FAWATERAK_ENV || 'staging').trim().toLowerCase(),
      baseUrl: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_BASE_URL || '').trim(),
      tokenUrl: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_TOKEN_URL || '').trim(),
      clientId: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_CLIENT_ID || '').trim(),
      clientSecret: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_CLIENT_SECRET || '').trim(),
      hashKey: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_HASH_KEY || '').trim(),
      webhookToken: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_WEBHOOK_TOKEN || '').trim(),
    },
  },

  // Sign-up and go-live rules (modules/auth/signupPolicy.js). Three switches,
  // all off unless set to exactly "true"; off is the behaviour from before
  // they existed, so they can be turned on one at a time after the dashboard
  // that understands them is deployed, and turned off again to go back:
  //   requirePlan          a plan (and the terms) must be chosen at sign-up,
  //                        while at least one plan is public;
  //   requireVerification  a new email/password account signs in only after
  //                        a 6-digit code sent to its email or phone;
  //   requireSubscription  a new store starts as a draft: it can be built but
  //                        not published or sell until a trial or a paid
  //                        subscription starts.
  // Under NODE_ENV=test they start off whatever the .env says; a test that
  // needs one sets it on this object at runtime.
  signup: {
    requirePlan: process.env.NODE_ENV !== 'test' && process.env.REQUIRE_PLAN_AT_SIGNUP === 'true',
    requireVerification: process.env.NODE_ENV !== 'test' && process.env.REQUIRE_SIGNUP_VERIFICATION === 'true',
    requireSubscription: process.env.NODE_ENV !== 'test' && process.env.REQUIRE_SUBSCRIPTION_TO_GO_LIVE === 'true',
    // Draft stores one person may hold while none of their stores is live.
    draftStoresPerUser: Math.max(1, parseInt(process.env.DRAFT_STORES_PER_USER || '1', 10) || 1),
    // Country calling codes a verification SMS may go to (digits, no "+").
    // Anything else is refused, so the SMS channel can't be pointed at premium
    // numbers abroad. Unset: Egypt only.
    smsCountryCodes: csvList(process.env.VERIFICATION_SMS_COUNTRY_CODES, '20').map((c) => c.replace(/^\+/, '')),
    // How a merchant pays while there is no gateway, shown next to the
    // subscribe button. Plain text; empty hides the block.
    paymentInstructions: {
      ar: (process.env.PAYMENT_INSTRUCTIONS_AR || '').trim(),
      en: (process.env.PAYMENT_INSTRUCTIONS_EN || '').trim(),
    },
  },

  // COD confirmation queue. A claim locks a task to one agent for this long;
  // an expired lock returns the task to Pending the next time the queue is
  // read or a task claimed (see modules/cod/confirmationService.js).
  confirmation: {
    lockTtlMinutes: Math.max(1, parseInt(process.env.CONFIRMATION_LOCK_TTL_MINUTES || '15', 10) || 15),
  },

  // Outbound webhooks to merchants' own systems (modules/webhooks).
  webhooks: {
    signingAlgo: process.env.WEBHOOK_SIGNING_ALGO || 'sha256',
    // The API process runs the observer + dispatcher loop itself every
    // intervalMs, so events leave within seconds with no extra service. Turn
    // it off (WEBHOOKS_IN_PROCESS=false) to run scripts/dispatch-webhooks.js
    // from a cron service instead; running both is safe, only slower to no
    // purpose. Never on under NODE_ENV=test — the suite drives it by hand.
    inProcess: process.env.NODE_ENV !== 'test' && process.env.WEBHOOKS_IN_PROCESS !== 'false',
    intervalMs: Math.max(1000, parseInt(process.env.WEBHOOKS_INTERVAL_MS || '5000', 10) || 5000),
    // A merchant types the URL, and this server then POSTs to it: an address
    // inside our own network (localhost, 10/8, the cloud metadata service…)
    // must never be reachable that way. Allowed outside production only, so a
    // developer can point a webhook at a receiver on their own machine.
    allowPrivateUrls:
      process.env.WEBHOOKS_ALLOW_PRIVATE_URLS !== undefined
        ? process.env.WEBHOOKS_ALLOW_PRIVATE_URLS === 'true'
        : process.env.NODE_ENV !== 'production',
    timeoutMs: Math.max(1000, parseInt(process.env.WEBHOOKS_TIMEOUT_MS || '10000', 10) || 10000),
    batchSize: Math.max(1, parseInt(process.env.WEBHOOKS_BATCH_SIZE || '50', 10) || 50),
  },

  // Merchant courier accounts (modules/shipping/carriers). The key encrypts
  // the credentials each merchant connects (AES-256-GCM, see
  // core/utils/credentialsCipher.js): 32 bytes, base64. Unset or malformed
  // disables carrier features with a 503 — it never stops the app booting.
  carriers: {
    credentialsKey: (process.env.CARRIER_CREDENTIALS_KEY || '').trim(),
    // POST /webhooks/carriers/:code/:token, per token per window.
    webhookRateLimitMax: parseInt(process.env.CARRIER_WEBHOOK_RATE_LIMIT_MAX || '300', 10),
    // Which adapters exist on this server (modules/shipping/carriers/index.js).
    // CARRIERS_ENABLED: for every store (unset: bosta; set but empty: none).
    // CARRIERS_BETA: only for the stores whose slugs are in
    // CARRIERS_BETA_WORKSPACES; every other store never sees them.
    enabled: csvList(process.env.CARRIERS_ENABLED, 'bosta'),
    beta: csvList(process.env.CARRIERS_BETA, ''),
    betaWorkspaces: csvList(process.env.CARRIERS_BETA_WORKSPACES, ''),
    // scripts/sync-carrier-shipments.js: shipments per run, and how long a
    // shipment is polled at all after it was booked.
    syncBatchSize: Math.max(1, parseInt(process.env.CARRIER_SYNC_BATCH_SIZE || '200', 10) || 200),
    pollMaxAgeDays: Math.max(1, parseInt(process.env.CARRIER_POLL_MAX_AGE_DAYS || '45', 10) || 45),
  },

  // Storefront analytics (modules/analytics). The event ingest can read a
  // visitor's country/region/city from CDN geo headers, but only from the
  // CDNs named here: this API is not behind a CDN today, so any client could
  // send those headers itself. Unset or empty trusts none and geo is null.
  // Accepted: cloudflare, vercel, cloudfront.
  analytics: {
    geoHeaders: csvList(process.env.ANALYTICS_GEO_HEADERS, ''),
  },
};

module.exports = env;
