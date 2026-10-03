'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace, refuseDraftOrders } = require('../../core/middleware/publicWorkspace');
const { idempotent } = require('../../core/middleware/idempotency');
const { trackingLimiter, suggestLimiter, uploadLimiter } = require('../../core/middleware/rateLimiters');
const customerUploadController = require('../customerUploads/customerUploadController');
const { collectOptionFilters } = require('./optionFilters');
const controller = require('./storefrontController');
const cartController = require('../cart/cartController');
const checkoutController = require('../checkout/checkoutController');
const reviewController = require('../reviews/reviewController');
const reviewSchemas = require('../reviews/reviewValidation');
const schemas = require('./storefrontValidation');
const checkoutSchemas = require('../checkout/checkoutValidation');
const checkoutSessionController = require('../checkoutSessions/checkoutSessionController');
const checkoutSessionSchemas = require('../checkoutSessions/checkoutSessionValidation');
const onlinePaymentController = require('../payments/onlinePaymentController');
const onlinePaymentSchemas = require('../payments/onlinePaymentValidation');
const botProtection = require('../risk/botProtection');
const checkoutOtp = require('../risk/checkoutOtp');
const lostOrders = require('../checkoutSessions/lostOrderService');
const lostOrderController = require('../checkoutSessions/lostOrderController');

const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

// Order bumps, cross-sell, the thank-you upsell and the exit popup (modules/offers).
router.use(require('../offers/publicOfferRoutes'));

// What the checkout form needs to pass the bot guard (a fresh time token).
router.get('/checkout/guard', botProtection.guardConfig);
// The code-entry step of a checkout that answered 428 OTP_REQUIRED.
router.post('/checkout/otp/verify', checkoutOtp.verify);
router.post('/checkout/otp/resend', checkoutOtp.resend);
// What a recovery link (/r/:token) rebuilds: the cart and the form.
router.get('/recover/:token', lostOrderController.recover);

router.get('/', validate(schemas.workspaceParam), controller.getStore);
router.get('/policies/:key', validate(schemas.getPolicy), controller.getPolicy);
router.get('/sitemap', validate(schemas.workspaceParam), controller.getSitemap);
router.get('/products', collectOptionFilters, validate(schemas.listProducts), controller.listProducts);
// Above '/products/:idOrSlug', so "suggest" is never read as a product slug.
router.get('/products/suggest', suggestLimiter, validate(schemas.suggest), controller.suggestProducts);
router.get('/products/:idOrSlug', validate(schemas.getProduct), controller.getProduct);
router.post('/products/:productId/reviews', validate(reviewSchemas.submit), reviewController.submit);
router.get('/collections', validate(schemas.workspaceParam), controller.listCollections);
// A shopper's photo for a product's image field (customerUploads). Limited
// before multer reads a byte; multer refuses anything over 15 MB mid-stream.
router.post('/uploads', uploadLimiter, customerUploadController.acceptFile, customerUploadController.create);
router.get('/collections/:collectionId', validate(schemas.getCollection), controller.getCollection);

// Shopper order lookup. The limiter runs ahead of `validate` so a request that
// can't pass validation never reaches the database; it keys on the phone and
// order number, not the IP (see rateLimiters.js).
router.get('/orders/track', trackingLimiter, validate(schemas.track), controller.trackOrder);

// Checkout-form autosave for abandoned-checkout recovery. An upsert keyed on
// the visitor, so a replay is harmless and it takes no Idempotency-Key.
router.post('/checkout-sessions', validate(checkoutSessionSchemas.capture), refuseDraftOrders, checkoutSessionController.capture);

// Read-only: prices the shipping line the checkout would get.
router.post('/shipping-quote', validate(schemas.shippingQuote), controller.shippingQuote);

// The payment methods the checkout offers (COD only while online payments
// are off). A valid X-Store-Preview header adds test-mode gateway methods.
// Whether a cash-on-delivery order by this phone needs a deposit first (payments/manualTransferService.js).
router.post(
  '/deposit-quote',
  validate({ params: onlinePaymentSchemas.storeMethods.params, body: require('joi').object({ phone: require('joi').string().max(32).allow('', null) }) }),
  require('express-async-handler')(async (req, res) =>
    res.json({ deposit: await require('../payments/manualTransferService').depositQuote(req.publicWorkspace, req.body || {}) })
  )
);
// Display currencies and their rates — for showing converted prices only (currencies/fxService.js).
router.get(
  '/currencies',
  validate({ params: onlinePaymentSchemas.storeMethods.params }),
  require('express-async-handler')(async (req, res) =>
    res.json({ currencies: await require('../currencies/fxService').getForStorefront(req.publicWorkspace) })
  )
);
router.get('/payment-methods', validate(onlinePaymentSchemas.storeMethods), onlinePaymentController.storefrontMethods);

// An unpaid online order, for the shopper holding its X-Payment-Token (given
// once, by the checkout that created the order).
router.get('/orders/:orderId/payment', validate(onlinePaymentSchemas.shopperStatus), onlinePaymentController.shopperStatus);
router.post('/orders/:orderId/payment/return', validate(onlinePaymentSchemas.shopperReturn), onlinePaymentController.shopperReturn);
router.post('/orders/:orderId/payment/retry', validate(onlinePaymentSchemas.shopperRetry), onlinePaymentController.shopperRetry);
router.post(
  '/orders/:orderId/payment/switch-to-cod',
  validate(onlinePaymentSchemas.shopperAction),
  onlinePaymentController.shopperSwitchToCod
);

// A draft store, reachable here only through a staff preview, sells nothing.
router.post(
  '/checkout',
  validate(checkoutSchemas.checkout),
  // Honeypot, time token, optional challenge — modules/risk/botProtection.
  botProtection.guardCheckout,
  refuseDraftOrders,
  // Phone verification, when the store asks for it — modules/risk/checkoutOtp.
  checkoutOtp.guardCheckout,
  idempotent('storefront.checkout')(checkoutController.checkout),
  // A refused checkout is kept as a lost order (checkoutSessions/lostOrderService).
  lostOrders.captureRefusal
);

module.exports = router;
