'use strict';

const env = require('../../../config/env');
const { AppError } = require('../../../core/errors/AppError');

/**
 * Delivery status and the suppression list are off unless
 * DELIVERY_STATUS_ENABLED=true: their routes answer 404, notify.js checks no
 * list and asks Twilio for no status callback.
 */
const deliveryStatusOn = () => Boolean(env.notifications.deliveryStatus);
const requireDeliveryStatus = (req, res, next) =>
  deliveryStatusOn() ? next() : next(new AppError('FEATURE_UNAVAILABLE', 'This feature is not available', 404));

module.exports = { deliveryStatusOn, requireDeliveryStatus };
