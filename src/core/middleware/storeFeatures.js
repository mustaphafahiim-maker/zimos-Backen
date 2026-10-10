'use strict';

const env = require('../../config/env');
const { AppError } = require('../errors/AppError');

/**
 * Store features that stay off until STORE_FEATURES names them
 * (env.storeFeatures): size_charts, product_questions, stock_alerts,
 * preorders, holiday_mode, url_redirects, product_specs, purchase_limits,
 * gift_options. Off, their routes answer 404 FEATURE_UNAVAILABLE and the
 * checkout, cart and product page behave as before.
 */
const STORE_FEATURES = Object.freeze([
  'size_charts',
  'product_questions',
  'stock_alerts',
  'preorders',
  'holiday_mode',
  'url_redirects',
  'product_specs',
  'purchase_limits',
  'gift_options',
  'price_history',
]);

const storeFeatureOn = (name) => env.storeFeatures.includes(name);

/** Express middleware: 404 FEATURE_UNAVAILABLE while `name` is off. */
const requireStoreFeature = (name) => (req, res, next) =>
  storeFeatureOn(name) ? next() : next(new AppError('FEATURE_UNAVAILABLE', 'This feature is not available', 404));

module.exports = { STORE_FEATURES, storeFeatureOn, requireStoreFeature };
