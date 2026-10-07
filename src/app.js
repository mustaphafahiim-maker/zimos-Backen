'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const requestId = require('./core/middleware/requestId');
const { corsPolicy } = require('./core/middleware/cors');
const { generalLimiter, storefrontLimiter, carrierWebhookLimiter, paymentWebhookLimiter } = require('./core/middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./core/middleware/errorHandler');
const { hostResolver } = require('./core/middleware/hostResolver');
const logger = require('./core/utils/logger');
const { redactUrl } = require('./core/utils/redactUrl');
const db = require('./db/models');

const authRoutes = require('./modules/auth/authRoutes');
const workspaceRoutes = require('./modules/workspaces/workspaceRoutes');
const catalogRoutes = require('./modules/catalog/catalogRoutes');
const inventoryRoutes = require('./modules/inventory/inventoryRoutes');
const customerRoutes = require('./modules/customers/customerRoutes');
const contactRoutes = require('./modules/contacts/contactRoutes');
const storesRoutes = require('./modules/stores/storesRoutes');
const dashboardRoutes = require('./modules/dashboard/dashboardRoutes');
const digitalRoutes = require('./modules/digital/digitalRoutes');
const aiRoutes = require('./modules/ai/aiRoutes');
const affiliateRoutes = require('./modules/affiliates/affiliateRoutes');
const customerSubscriptionRoutes = require('./modules/subscriptions/subscriptionRoutes');
const serviceListingRoutes = require('./modules/serviceListings/serviceListingRoutes');
const shoppableImageRoutes = require('./modules/shoppableImages/shoppableImageRoutes');
const courseRoutes = require('./modules/courses/courseRoutes');
const orderRoutes = require('./modules/orders/orderRoutes');
const returnRoutes = require('./modules/returns/returnRoutes');
const confirmationRoutes = require('./modules/cod/confirmationRoutes');
const paymentRoutes = require('./modules/payments/paymentRoutes');
const discountRoutes = require('./modules/discounts/discountRoutes');
const shippingRoutes = require('./modules/shipping/shippingRoutes');
const taxRoutes = require('./modules/tax/taxRoutes');
const storefrontRoutes = require('./modules/storefront/storefrontRoutes');
const cartRoutes = require('./modules/cart/cartRoutes');
const pagesRoutes = require('./modules/pages/pagesRoutes');
const pagesPublicRoutes = require('./modules/pages/pagesPublicRoutes');
const funnelsRoutes = require('./modules/funnels/funnelsRoutes');
const funnelsPublicRoutes = require('./modules/funnels/funnelsPublicRoutes');
const quickstartRoutes = require('./modules/quickstart/quickstartRoutes');
const quickstartPublicRoutes = require('./modules/quickstart/quickstartPublicRoutes');
const billingRoutes = require('./modules/billing/billingRoutes');
const publicPlansRoutes = require('./modules/billing/publicPlansRoutes');
const workspaceBillingRoutes = require('./modules/billing/workspaceBillingRoutes');
const adminRoutes = require('./modules/billing/adminRoutes');
const platformAdminRoutes = require('./modules/platformAdmin/platformAdminRoutes');
const domainsRoutes = require('./modules/domains/domainsRoutes');
const mediaRoutes = require('./modules/media/mediaRoutes');
const reviewRoutes = require('./modules/reviews/reviewRoutes');
const fraudRoutes = require('./modules/fraud/fraudRoutes');
const supportRoutes = require('./modules/support/supportRoutes');
const checkoutSessionRoutes = require('./modules/checkoutSessions/checkoutSessionRoutes');
const templateRoutes = require('./modules/templates/templateRoutes');
const carrierRoutes = require('./modules/shipping/carrierRoutes');
const carrierWebhookRoutes = require('./modules/shipping/carrierWebhookRoutes');
const onlinePaymentRoutes = require('./modules/payments/onlinePaymentRoutes');
const paymentWebhookRoutes = require('./modules/payments/paymentWebhookRoutes');
const analyticsRoutes = require('./modules/analytics/analyticsRoutes');
const eventsPublicRoutes = require('./modules/analytics/eventsPublicRoutes');
const auditRoutes = require('./modules/audit/auditRoutes');
const invoiceRoutes = require('./modules/invoices/invoiceRoutes');
const whatsappRoutes = require('./modules/whatsapp/whatsappRoutes');
const automationRoutes = require('./modules/automations/automationRoutes');
const settlementRoutes = require('./modules/settlements/settlementRoutes');
const profitRoutes = require('./modules/profit/profitRoutes');
const serverPixelsRoutes = require('./modules/marketing/serverPixelsRoutes');
const apiKeyRoutes = require('./modules/apiKeys/apiKeyRoutes');
const appGate = require('./modules/apps/appGate');
const webhookRoutes = require('./modules/webhooks/webhookRoutes');
const publicApiRoutes = require('./modules/publicApi/publicApiRoutes');
const merchantNotificationRoutes = require('./modules/notifications/merchantNotificationRoutes');
const trackingPixelRoutes = require('./modules/marketing/trackingPixelRoutes');
const inboxRoutes = require('./modules/whatsapp/inboxRoutes');
const orderEmailRoutes = require('./modules/notifications/orderEmailRoutes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// EJS view engine for the built-in storefront viewer.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(requestId);
// Error messages in Arabic or French when the request asks (core/errors/errorMessages.js).
app.use(require('./core/errors/errorMessages').translateErrors);
app.use(helmet());
// Any origin for the public /api/v1/store API, the CORS_ORIGINS allowlist
// everywhere else (see core/middleware/cors.js).
app.use(corsPolicy);
// Storefront analytics beacons get their own, much smaller, body limit. Mounted
// before the API-wide parser below, which then skips the already-read body.
app.use(`/api/${env.apiVersion}/store/:workspaceId/events`, eventsPublicRoutes.eventsBodyParser);
// `verify` keeps the exact bytes Express parsed so webhook signatures can be
// checked against what the gateway actually signed — a re-serialised req.body
// would differ by key order or whitespace and never match. See
// modules/billing/gatewaySignature.js.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (!env.isTest) {
  app.use((req, res, next) => {
    // Gateway callbacks carry their signature in the query string (?hmac=):
    // it never reaches a log line.
    logger.info(`${req.method} ${redactUrl(req.originalUrl)}`, { requestId: req.id, ip: req.ip });
    next();
  });
}

// The public storefront API is limited per shopper rather than per IP (see
// rateLimiters.js); generalLimiter skips whatever this limiter handled.
app.use(`/api/${env.apiVersion}/store`, storefrontLimiter);
// Courier webhooks all come from the courier's servers: limited per merchant
// webhook token, not per IP (see rateLimiters.js).
app.use(`/api/${env.apiVersion}/webhooks/carriers`, carrierWebhookLimiter);
app.use(`/api/${env.apiVersion}/webhooks/payments`, paymentWebhookLimiter);
app.use(generalLimiter);

// --- Health / readiness -----------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  try {
    await db.sequelize.authenticate();
    res.json({ status: 'ready', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', database: 'disconnected' });
  }
});

// --- Uploaded media (local disk, no CDN) --------------------------------
// Files written by POST /workspaces/:id/media are served straight from
// public/uploads so the returned URL works directly in logoUrl/imageUrl.
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'), { fallthrough: true, maxAge: '1h' }));

// --- Storefront host routing (subdomain / custom domain -> /shop/:id) -----
// Runs after /health so monitoring works on any host; before all route mounts.
app.use(hostResolver);

// --- API v1 --------------------------------------------------------------
const v1 = express.Router();
// The signed-in person's devices for push notifications (notifications/push).
v1.use('/me/push', require('./modules/notifications/push/pushService').router);
// ZIMOS's referral program for merchants: their code, link, earnings and payout requests.
v1.use('/me/referrals', require('./modules/referrals/merchantReferrals').me);
// Help center, Telegram and tutorial links for the dashboard (platformAdmin/educationLinks.js).
v1.use('/me/education', require('./modules/platformAdmin/educationLinks').me);
// The signed-in person's name and picture (before /auth, which has no such route).
v1.use('/auth/me/profile', require('./modules/auth/profileRoutes'));
// Changing the sign-in email, confirmed from the new address (auth/emailChange.js).
v1.use('/auth/me/email', require('./modules/auth/emailChange').me);
v1.use('/auth/email-change', require('./modules/auth/emailChange').publicRouter);
v1.use('/auth', authRoutes);
// Public template gallery — no auth, shown before a workspace even exists.
v1.use('/templates', templateRoutes);
// Must be registered BEFORE the generic '/workspaces' mount: workspaceRoutes
// runs the strict `authenticate` for every path under '/workspaces', which
// would reject the quickstart query-string / hidden-field token before it
// reaches this router's `authenticateFlexible`.
v1.use('/workspaces/:workspaceId/quickstart', quickstartRoutes);
v1.use('/workspaces', workspaceRoutes);
// Bulk stock and price update from a sheet (catalog/importExport/bulkUpdate.js, item 243).
v1.use('/workspaces/:workspaceId/catalog/bulk-update', require('./modules/catalog/importExport/bulkUpdate').router);
v1.use('/workspaces/:workspaceId/catalog', catalogRoutes);
v1.use('/workspaces/:workspaceId/inventory', inventoryRoutes);
// Merge duplicate customers (customers/customerMerge.js, item 248).
v1.use('/workspaces/:workspaceId/customer-merge', require('./modules/customers/customerMerge').router);
// Transfer a store to another owner (storeTransfer, item 252).
v1.use('/workspaces/:workspaceId/ownership-transfer', require('./modules/storeTransfer').router);
// Customer timeline (customerTimeline, item 250).
v1.use('/workspaces/:workspaceId/customers/:customerId/timeline', require('./modules/customerTimeline').router);
v1.use('/workspaces/:workspaceId/customers', customerRoutes);
// Contacts from a CSV / Excel sheet (item 187), ahead of /contacts/:customerId.
v1.use('/workspaces/:workspaceId/contacts/import', require('./modules/contacts/contactImport').router);
v1.use('/workspaces/:workspaceId/contacts', contactRoutes.staff);
v1.use('/workspaces/:workspaceId/duplicate', storesRoutes.duplicate);
v1.use('/me/stores', storesRoutes.me);
v1.use('/service-listings', serviceListingRoutes.merchant);
v1.use('/admin/service-listings', serviceListingRoutes.admin);
v1.use('/workspaces/:workspaceId/digital', digitalRoutes.staff);
v1.use('/workspaces/:workspaceId/ai', aiRoutes);
v1.use('/workspaces/:workspaceId/affiliates', affiliateRoutes.staff);
v1.use('/workspaces/:workspaceId/subscriptions', customerSubscriptionRoutes.staff);
v1.use('/workspaces/:workspaceId/shoppable-images', shoppableImageRoutes.staff);
v1.use('/workspaces/:workspaceId/courses', courseRoutes.staff);
v1.use('/workspaces/:workspaceId', dashboardRoutes);
// Scan to pack (orders/scanToPack.js, item 249).
v1.use('/workspaces/:workspaceId/orders/:orderId/pack', require('./modules/orders/scanToPack').router);
v1.use('/workspaces/:workspaceId/orders', orderRoutes);
v1.use('/workspaces/:workspaceId/exports', require('./modules/orders/exportFileRoutes'));
v1.use('/workspaces/:workspaceId/account-settings', require('./modules/workspaces/accountSettings').router);
v1.use('/workspaces/:workspaceId/saved-views', require('./modules/workspaces/savedViews').router);
v1.use('/workspaces/:workspaceId/returns', returnRoutes);
v1.use('/workspaces/:workspaceId/confirmation-tasks', confirmationRoutes);
v1.use('/workspaces/:workspaceId', paymentRoutes);
v1.use('/workspaces/:workspaceId/discounts', discountRoutes);
v1.use('/workspaces/:workspaceId/bundles', require('./modules/bundles/bundleRoutes'));
v1.use('/workspaces/:workspaceId/offers', appGate.requireAppForChanges('offers'), require('./modules/offers/offersRoutes'));
// Product feeds for ad channels: /feeds/:workspaceSlug/:channel.xml|csv (public, no auth).
v1.use('/feeds', require('./modules/offers/productFeed').publicRouter);
// Before the shipping router: shipping groups (shipping/shippingProfiles.js).
v1.use('/workspaces/:workspaceId/shipping/profiles', require('./modules/shipping/shippingProfiles').router);
v1.use('/workspaces/:workspaceId/shipping/options', require('./modules/shipping/shippingOptions').router);
v1.use('/workspaces/:workspaceId/shipping', shippingRoutes);
v1.use('/workspaces/:workspaceId/tax-rates', taxRoutes);
v1.use('/workspaces/:workspaceId/websites', pagesRoutes);
v1.use('/workspaces/:workspaceId/funnels', funnelsRoutes);
v1.use('/workspaces/:workspaceId/domains', domainsRoutes);
// Code customizations: the merchant's own HTML/CSS/JS slots (website.publish).
v1.use('/workspaces/:workspaceId/custom-code', require('./modules/customCode/customCodeRoutes').router);
// The theme catalog for this store (themes/themesCatalog.js).
v1.use('/workspaces/:workspaceId/themes', require('./modules/themes/themesCatalog').router);
// Page sections saved for reuse across pages and funnels (website.edit).
v1.use('/workspaces/:workspaceId/saved-sections', require('./modules/savedSections/savedSectionsRoutes'));
// Split tests on funnel steps (funnels.manage).
v1.use('/workspaces/:workspaceId/experiments', require('./modules/funnels/splitTests').router);
v1.use('/workspaces/:workspaceId/product-tests', require('./modules/catalog/productTests').router);
// Translations of the merchant's own content, and the languages overview (website.edit).
v1.use('/workspaces/:workspaceId/translations', require('./modules/translations/translations').router);
v1.use('/workspaces/:workspaceId/media', mediaRoutes);
v1.use('/workspaces/:workspaceId/reviews', reviewRoutes);
v1.use('/workspaces/:workspaceId/fraud', fraudRoutes);
v1.use('/workspaces/:workspaceId/support', supportRoutes);
v1.use('/workspaces/:workspaceId/billing', workspaceBillingRoutes);
v1.use('/workspaces/:workspaceId/checkout-sessions', checkoutSessionRoutes);
v1.use('/workspaces/:workspaceId/carriers', carrierRoutes);
v1.use('/workspaces/:workspaceId/shipment-batches', require('./modules/shipping/bulkShipRoutes'));
v1.use('/workspaces/:workspaceId/payments', onlinePaymentRoutes);
v1.use('/workspaces/:workspaceId/analytics', analyticsRoutes);
v1.use('/workspaces/:workspaceId/audit-logs', auditRoutes);
v1.use('/workspaces/:workspaceId/invoices', invoiceRoutes);
v1.use('/workspaces/:workspaceId/whatsapp', appGate.requireAppForChanges('whatsapp'), whatsappRoutes.staff);
v1.use('/workspaces/:workspaceId/automations', automationRoutes);
v1.use('/workspaces/:workspaceId/settlements', settlementRoutes);
v1.use('/workspaces/:workspaceId/profit', profitRoutes);
v1.use('/workspaces/:workspaceId/manual-transfers', require('./modules/payments/manualTransferRoutes'));
v1.use('/workspaces/:workspaceId/payment-rules', require('./modules/payments/paymentRulesRoutes'));
v1.use('/workspaces/:workspaceId/currencies', require('./modules/currencies/currencyRoutes'));
v1.use('/workspaces/:workspaceId/saved-payment-methods', require('./modules/payments/savedMethods/savedMethodRoutes'));
v1.use('/workspaces/:workspaceId/server-pixels', appGate.requireAppForChanges('tracking_pixels'), serverPixelsRoutes.staff);
v1.use('/workspaces/:workspaceId/api-keys', appGate.requireAppForChanges('public_api'), apiKeyRoutes);
v1.use('/workspaces/:workspaceId/webhooks', appGate.requireAppForChanges('webhooks'), webhookRoutes);
// Lane 7: the app store, the app install link and dropshipping providers.
// Features that are apps take changes only while the store has the app (apps/appGate.js).
// Partner apps with OAuth (partnerApps/, item 265): developers, the merchant's approval, the token exchange, the app's page.
v1.use('/partner-apps', require('./modules/partnerApps').developer);
v1.use('/workspaces/:workspaceId/oauth', require('./modules/partnerApps').merchant);
v1.use('/workspaces/:workspaceId/apps/partner', require('./modules/partnerApps').embed);
v1.use('/oauth', require('./modules/partnerApps').oauth);
v1.use('/workspaces/:workspaceId/apps', require('./modules/apps/appRoutes'));
// Google Sheets sync: the account, the sheets, "Sync existing" (modules/sheets, SPEC §16.4).
// Smart collections: the "All products" collection and a manual re-fill (catalog/smartCollections.js).
v1.use('/workspaces/:workspaceId/smart-collections', require('./modules/catalog/smartCollections').router);
// The store's own regions → cities → areas (modules/places).
v1.use('/workspaces/:workspaceId/store-places', require('./modules/places/storePlaces').staff);
// Address suggestions at checkout (item 184).
v1.use('/workspaces/:workspaceId/address-autocomplete', require('./modules/places/autocomplete').staff);
// Sign in with Google for shoppers (spec-gaps item 217) — before the general shopper-accounts routes.
v1.use('/workspaces/:workspaceId/shopper-accounts/google', require('./modules/shopperAccounts/google').staff);
v1.use('/workspaces/:workspaceId/shopper-accounts', require('./modules/shopperAccounts').staff);
v1.use('/workspaces/:workspaceId/wishlists', require('./modules/shopperAccounts/wishlist').staff);
v1.use('/workspaces/:workspaceId/gift-cards', require('./modules/giftCards').staff);
v1.use('/workspaces/:workspaceId/blog', require('./modules/blog').staff);
v1.use('/workspaces/:workspaceId/marketplace', require('./modules/marketplace').merchant);
v1.use('/workspaces/:workspaceId/stock-alerts', require('./modules/stockAlerts').staff);
// Pre-orders (item 195).
v1.use('/workspaces/:workspaceId/preorders', require('./modules/preorders').router);
// Cookie consent (item 196).
v1.use('/workspaces/:workspaceId/cookie-consent', require('./modules/marketing/cookieConsent').router);
v1.use('/workspaces/:workspaceId/store-gate', require('./modules/storeGate').staff);
// Purchase limits per product (item 198).
v1.use('/workspaces/:workspaceId/purchase-limits', require('./modules/catalog/purchaseLimits').router);
v1.use('/workspaces/:workspaceId/delivery-estimates', require('./modules/shipping/deliveryEstimates').staff);
// Daily / weekly summary emails to team members (spec-gaps item 202).
v1.use('/workspaces/:workspaceId/scheduled-reports', require('./modules/scheduledReports').router);
// Loyalty points (spec-gaps item 203).
v1.use('/workspaces/:workspaceId/loyalty', require('./modules/loyalty').staff);
// Store credit (spec-gaps item 204).
v1.use('/workspaces/:workspaceId/store-credit', require('./modules/storeCredit').staff);
// Wholesale price lists by customer tag (spec-gaps item 205).
v1.use('/workspaces/:workspaceId/price-lists', require('./modules/priceLists').staff);
// Multiple stock locations (spec-gaps item 206).
v1.use('/workspaces/:workspaceId/stock-locations', require('./modules/stockLocations').router);
// Suppliers, purchase orders and stock counts (spec-gaps item 207).
v1.use('/workspaces/:workspaceId/stock-forecast', require('./modules/stockForecast').router);
v1.use('/workspaces/:workspaceId/stock-lots', require('./modules/stockLots').router);
v1.use('/workspaces/:workspaceId/purchasing', require('./modules/purchasing').router);
// Free gift with purchase (spec-gaps item 208).
v1.use('/workspaces/:workspaceId/free-gifts', require('./modules/freeGifts').router);
// Cart offers (spec-gaps item 253).
v1.use('/workspaces/:workspaceId/cart-offers', require('./modules/cartOffers').router);
// Spin to win (spec-gaps item 258).
v1.use('/workspaces/:workspaceId/spin-wheel', require('./modules/spinWheel').staff);
// Notes and follow-ups on customers (spec-gaps item 209).
v1.use('/workspaces/:workspaceId/customer-notes', require('./modules/customerNotes').router);
// Size charts (spec-gaps item 210).
v1.use('/workspaces/:workspaceId/size-charts', require('./modules/sizeCharts').staff);
// Storefront search analytics and synonyms (spec-gaps item 211).
v1.use('/workspaces/:workspaceId/search-insights', require('./modules/searchInsights').staff);
// Product questions and answers (spec-gaps item 212).
v1.use('/workspaces/:workspaceId/product-questions', require('./modules/productQuestions').staff);
// Gift wrap and gift message (spec-gaps item 214).
v1.use('/workspaces/:workspaceId/gift-options', require('./modules/giftOptions').staff);
// Holiday mode (spec-gaps item 216).
v1.use('/workspaces/:workspaceId/delivery-slots', require('./modules/deliverySlots').staff);
v1.use('/workspaces/:workspaceId/customer-referrals', require('./modules/customerReferrals').staff);
v1.use('/workspaces/:workspaceId/bought-together', require('./modules/boughtTogether').staff);
v1.use('/workspaces/:workspaceId/click-and-collect', require('./modules/clickAndCollect').staff);
v1.use('/workspaces/:workspaceId/price-schedules', require('./modules/priceSchedules').router);
v1.use('/workspaces/:workspaceId/customers/:customerId/business', require('./modules/businessCustomers').staff);
v1.use('/workspaces/:workspaceId/account-credit', require('./modules/accountCredit').staff);
v1.use('/workspaces/:workspaceId/product-specs', require('./modules/productSpecs').staff);
v1.use('/workspaces/:workspaceId/redirects', require('./modules/urlRedirects').staff);
v1.use('/workspaces/:workspaceId/store-locator', require('./modules/storeLocator').staff);
v1.use('/workspaces/:workspaceId/price-history', require('./modules/priceHistory').staff);
v1.use('/workspaces/:workspaceId/privacy-requests', require('./modules/privacyRequests').staff);
v1.use('/workspaces/:workspaceId/post-purchase-survey', require('./modules/postPurchaseSurvey').staff);
v1.use('/workspaces/:workspaceId/rfm', require('./modules/rfm').router);
v1.use('/workspaces/:workspaceId/store-reports', require('./modules/storeReports').router);
v1.use('/workspaces/:workspaceId/holiday-mode', require('./modules/holidayMode').router);
// VIP tiers (spec-gaps item 218).
v1.use('/workspaces/:workspaceId/vip-tiers', require('./modules/vipTiers').staff);
// B2B quote requests (spec-gaps item 219).
v1.use('/workspaces/:workspaceId/quotes', require('./modules/quotes').staff);
// Shopper self-service on orders (spec-gaps item 220).
v1.use('/workspaces/:workspaceId/order-self-service', require('./modules/shopperAccounts/orderSelfService').staff);
v1.use('/workspaces/:workspaceId/shopper-returns', require('./modules/returns/shopperReturns').staff);
v1.use('/workspaces/:workspaceId/fonts', require('./modules/fonts/storeFonts').staff);
v1.use('/workspaces/:workspaceId/storefront-texts', require('./modules/storefront/storefrontTexts').router);
v1.use('/workspaces/:workspaceId/integrations/google-sheets', appGate.requireAppForChanges('google_sheets'), require('./modules/sheets/sheetsRoutes').router);
v1.use('/workspaces/:workspaceId/dropship', require('./modules/dropship/dropshipRoutes'));
// Contacts to Mailchimp / Klaviyo lists (item 182).
v1.use('/workspaces/:workspaceId/email-marketing', require('./modules/emailMarketing/emailMarketing').router);
// Lane 7: the simple invite (sections → permissions) and support access.
v1.use('/workspaces/:workspaceId/team', require('./modules/team/teamRoutes'));
v1.use('/workspaces/:workspaceId/support-access', require('./modules/supportAccess/supportAccess').router);
v1.use('/workspaces/:workspaceId/notifications', merchantNotificationRoutes);
// The store as an app for shoppers: its home-screen name, icon and colour (website.publish).
v1.use('/workspaces/:workspaceId/store-app', require('./modules/storefront/storeApp').router);
v1.use('/workspaces/:workspaceId/tracking-pixels', appGate.requireAppForChanges('tracking_pixels'), trackingPixelRoutes);
// The customer service bot on WhatsApp: settings, "Try it", take over (whatsapp/bot).
v1.use('/workspaces/:workspaceId/wa-bot', appGate.requireAppForChanges('whatsapp', { except: ['/preview'] }), require('./modules/whatsapp/bot/botService').router);
v1.use('/workspaces/:workspaceId/inbox', appGate.requireAppForChanges('whatsapp', { except: ['/stream-ticket'] }), inboxRoutes);
v1.use('/workspaces/:workspaceId/order-emails', orderEmailRoutes);
// The inbox's live stream (SSE): opened with a short-lived ticket, not a staff session.
v1.use('/inbox-stream', inboxRoutes.stream);
// The analytics live view's SSE stream — opened with a ticket, like the inbox stream.
v1.use('/analytics-stream', require('./modules/analytics/realtimeStream').streamRouter);
// WhatsApp Cloud API webhook — public; Meta's X-Hub-Signature-256 over the raw
// body proves the sender.
v1.use('/webhooks/whatsapp', whatsappRoutes.webhook);
v1.use('/billing', billingRoutes);
// The plans on offer — public, for the marketing site and the sign-up form.
v1.use('/plans', publicPlansRoutes);
// Courier status webhooks — public; the token in the path is the identity.
v1.use('/webhooks/carriers', carrierWebhookRoutes);
// Payment gateway callbacks — public; the token names the account, the HMAC
// proves the sender.
v1.use('/webhooks/payments', paymentWebhookRoutes);
// The sandbox gateway's hosted payment page — only where that gateway is registered.
if (require('./modules/payments/gateways').isGateway('sandbox')) v1.use('/sandbox-pay', require('./modules/payments/sandboxPayRoutes'));
// The sandbox courier's "advance the parcel" endpoint — only where that courier is registered.
if (require('./modules/shipping/carriers').getAdapter('sandbox')) v1.use('/dev/sandbox', require('./modules/shipping/sandboxCarrierRoutes'));
// Presigned-upload stand-ins for local disk (media/storage/sandboxRoutes.js) — never in production.
if (env.storage.provider === 'local' && !env.isProduction) v1.use('/storage-sandbox', require('./modules/media/storage/sandboxRoutes'));
v1.use('/admin', adminRoutes);
// Plans, subscriptions, feature flags and announcements. Shares the /admin
// mount with adminRoutes above, which owns /workspaces and /dashboard.
v1.use('/admin', platformAdminRoutes);

// --- Public API (a workspace API key, no staff session) --------------------
// Orders and their statuses for merchants' own integrations; see
// docs/public-api.md. Outbound webhooks are sent by modules/webhooks.
v1.use('/public', publicApiRoutes);
// The same API under the path the spec and other platforms' docs use.
// The store's MCP server for AI assistants, on a store API key (modules/mcp).
app.use('/api/public/v1/mcp', require('./modules/mcp/mcpServer').router);
app.use('/api/public/v1', publicApiRoutes);

// --- Public storefront (no staff auth) ------------------------------------
// Which store a custom domain belongs to — before the :workspaceId routes,
// which would otherwise read "resolve-host" as a store.
v1.use('/store/resolve-host', require('./modules/domains/domainSettings').publicRouter);
v1.use('/store/:workspaceId/pages', pagesPublicRoutes);
v1.use('/store/:workspaceId/custom-code', require('./modules/customCode/customCodeRoutes').publicRouter);
v1.use('/store/:workspaceId/funnels', funnelsPublicRoutes);
// Storefront visit tracking (page views, cart, checkout, purchase).
v1.use('/store/:workspaceId/events', eventsPublicRoutes);
v1.use('/store/:workspaceId/forms', contactRoutes.store);
v1.use('/store/:workspaceId/downloads', digitalRoutes.store);
v1.use('/store/:workspaceId/affiliate', affiliateRoutes.portal);
v1.use('/store/:workspaceId/subscriptions', customerSubscriptionRoutes.portal);
v1.use('/store/:workspaceId/shoppable-images', shoppableImageRoutes.store);
v1.use('/store/:workspaceId/learn', courseRoutes.portal);
// A store's uploaded fonts, served to any origin (modules/fonts).
v1.use('/store/:workspaceId/places', require('./modules/places/storePlaces').store);
v1.use('/store/:workspaceId/address', require('./modules/places/autocomplete').store);
// Shopper accounts: sign in with a code, orders, addresses (item 185).
// The signed-in shopper's wishlist (item 188), ahead of the account router.
v1.use('/store/:workspaceId/account/wishlist', require('./modules/shopperAccounts/wishlist').store);
v1.use('/store/:workspaceId/account/google', require('./modules/shopperAccounts/google').store);
v1.use('/store/:workspaceId/account/referral', require('./modules/customerReferrals').account);
v1.use('/store/:workspaceId/referrals', require('./modules/customerReferrals').store);
v1.use('/store/:workspaceId/spin-wheel', require('./modules/spinWheel').store);
v1.use('/store/:workspaceId/account/business', require('./modules/businessCustomers').account);
v1.use('/store/:workspaceId/account/on-account', require('./modules/accountCredit').account);
v1.use('/store/:workspaceId/account/privacy', require('./modules/privacyRequests').account);
v1.use('/store/:workspaceId/account/vip', require('./modules/vipTiers').account);
v1.use('/store/:workspaceId/account/loyalty', require('./modules/loyalty').account);
v1.use('/store/:workspaceId/account/store-credit', require('./modules/storeCredit').account);
v1.use('/store/:workspaceId/price-list', require('./modules/priceLists').store);
v1.use('/store/:workspaceId/size-chart', require('./modules/sizeCharts').store);
// The mix-and-match box builder (spec-gaps item 215).
v1.use('/store/:workspaceId/bundles', require('./modules/bundles/mixAndMatch').store);
v1.use('/store/:workspaceId/delivery-slots', require('./modules/deliverySlots').store);
v1.use('/store/:workspaceId/pickup', require('./modules/clickAndCollect').store);
v1.use('/store/:workspaceId/specs', require('./modules/productSpecs').store);
v1.use('/store/:workspaceId/redirects', require('./modules/urlRedirects').store);
v1.use('/store/:workspaceId/branches', require('./modules/storeLocator').store);
v1.use('/store/:workspaceId/lowest-prices', require('./modules/priceHistory').store);
v1.use('/store/:workspaceId/survey', require('./modules/postPurchaseSurvey').store);
v1.use('/store/:workspaceId/quotes', require('./modules/quotes').store);
v1.use('/store/:workspaceId/orders/:orderId/self-service', require('./modules/shopperAccounts/orderSelfService').store);
v1.use('/store/:workspaceId/search', require('./modules/searchInsights').store);
v1.use('/store/:workspaceId/products/:productId/questions', require('./modules/productQuestions').store);
v1.use('/store/:workspaceId/loyalty', require('./modules/loyalty').store);
v1.use('/store/:workspaceId/account', require('./modules/shopperAccounts').store);
// Returns asked for by the shopper (item 186).
v1.use('/store/:workspaceId/returns', require('./modules/returns/shopperReturns').store);
// Gift cards (item 189).
v1.use('/store/:workspaceId/gift-cards', require('./modules/giftCards').store);
// The store's blog (item 190).
v1.use('/store/:workspaceId/blog', require('./modules/blog').store);
// Back-in-stock alerts (item 194).
v1.use('/store/:workspaceId/stock-alerts', require('./modules/stockAlerts').store);
// Store gates: password, coming soon, age check (item 197).
v1.use('/store/:workspaceId/gate', require('./modules/storeGate').store);
// Estimated delivery dates (item 199).
v1.use('/store/:workspaceId/delivery-estimate', require('./modules/shipping/deliveryEstimates').store);
// The visitor's country and device, for element display rules (item 191).
v1.get('/store/:workspaceId/visitor-context', require('./core/middleware/publicWorkspace').resolvePublicWorkspace, (req, res, next) => require('./modules/pages/displayRules').visitorContext(req).then((ctx) => res.set('Cache-Control', 'private, no-store').json(ctx), next));
v1.use('/store/:workspaceId/fonts', require('./modules/fonts/storeFonts').store);
v1.use('/store/:workspaceId', storefrontRoutes);
v1.use('/store/:workspaceId/cart', cartRoutes);

// The signed, short-lived link to a shopper's photo that staff open from an
// order (customerUploads/uploadLinks.js). The signature is the credential.
v1.get('/customer-uploads/:uploadId', require('./modules/customerUploads/customerUploadController').readSigned);

app.use(`/api/${env.apiVersion}`, v1);

// --- Public server-rendered storefront (HTML, no staff auth) -------------
app.use('/shop/:workspaceId', quickstartPublicRoutes);

// --- API documentation ----------------------------------------------------
const openapiSpec = require('../docs/openapi.json');
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
app.get('/docs.json', (req, res) => res.json(openapiSpec));
// The public API (modules/publicApi) has its own description, for merchants'
// developers and partners: docs/public-openapi.json, written by
// scripts/build-public-openapi.js.
const publicOpenapiSpec = require('../docs/public-openapi.json');
app.use('/public-docs', swaggerUi.serveFiles(publicOpenapiSpec), swaggerUi.setup(publicOpenapiSpec, { customSiteTitle: 'ZIMOS Public API' }));
app.get('/public-docs.json', (req, res) => res.json(publicOpenapiSpec));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
