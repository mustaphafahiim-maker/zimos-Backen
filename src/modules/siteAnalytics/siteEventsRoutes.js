'use strict';

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { notFoundHandler } = require('../../core/middleware/errorHandler');
const { isBot } = require('../analytics/clientDetect');
const siteTraffic = require('./siteTrafficService');

/**
 * POST /api/v1/public/site-events — the marketing site's anonymous beacon
 * (siteTrafficService). app.js mounts it before the API-wide body parser, so
 * this route reads its own small body. Off (env.siteAnalytics.enabled, read
 * per request) the path answers 404 like any unknown one.
 *
 * The client sends text/plain so the browser makes no preflight; CORS headers
 * go only to SITE_ANALYTICS_ORIGINS (core/middleware/cors.js), and a request
 * from any other origin, or with none, is refused here as well.
 */

const MAX_BODY_BYTES = 2 * 1024;
const PER_IP_PER_MINUTE = 120;

const id = Joi.string().pattern(/^[A-Za-z0-9-]{8,64}$/);
const short = Joi.string().trim().max(100).allow('');

// Strict: an unknown key is an error, not dropped (validate() strips them).
const eventSchema = Joi.object({
  visitorId: id.required(),
  sessionId: id.required(),
  event: Joi.string().valid('view', 'ping', 'cta_click').required(),
  path: Joi.string().max(300).pattern(/^\//).required(),
  locale: Joi.string().valid('ar', 'en').optional(),
  referrer: Joi.string().max(500).allow('').optional(),
  utmSource: short.optional(),
  utmMedium: short.optional(),
  utmCampaign: short.optional(),
}).unknown(false);

const jsonParser = express.json({ limit: MAX_BODY_BYTES, type: ['application/json', 'text/plain'] });

function bodyParser(req, res, next) {
  jsonParser(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(new AppError('PAYLOAD_TOO_LARGE', `Body is larger than ${MAX_BODY_BYTES} bytes`, 413));
    // INVALID_JSON: the code the rest of our API answers for a body it cannot
    // read (core/middleware/errorHandler).
    if (err.status >= 400 && err.status < 500) return next(new AppError('INVALID_JSON', 'Request body is not valid JSON', 400));
    return next(err);
  });
}

// Off: the same 404 as an unknown path. Falling through would reach the
// /public API router, which asks for an API key (401) and so would tell a
// caller the path exists.
function enabled(req, res, next) {
  return env.siteAnalytics.enabled ? next() : notFoundHandler(req, res, next);
}

function allowedOrigin(req, res, next) {
  const origin = String(req.get('origin') || '').toLowerCase();
  if (!origin || !env.siteAnalytics.origins.includes(origin)) {
    return next(new AppError('ORIGIN_NOT_ALLOWED', 'This origin may not send site events', 403));
  }
  return next();
}

// Known crawlers are answered as if stored, and nothing is kept.
function ignoreBots(req, res, next) {
  return isBot(req.get('user-agent')) ? res.status(204).end() : next();
}

function strictBody(req, res, next) {
  const { error, value } = eventSchema.validate(req.body, { abortEarly: false, stripUnknown: false });
  if (error) {
    return next(new ValidationError(error.details.map((d) => ({ field: d.path.join('.'), message: d.message })), 'Invalid body'));
  }
  req.body = value;
  return next();
}

const defaultLimiter = createIpMinuteLimiter('site-events', PER_IP_PER_MINUTE, { skip: () => env.isTest });

function createSiteEventsRouter({ limiter = defaultLimiter } = {}) {
  const router = express.Router();
  router.use(enabled);
  router.post(
    '/',
    limiter,
    bodyParser,
    ignoreBots,
    allowedOrigin,
    strictBody,
    asyncHandler(async (req, res) => {
      await siteTraffic.recordEvent(req.body, req);
      res.status(204).end();
    })
  );
  return router;
}

module.exports = createSiteEventsRouter();
module.exports.createSiteEventsRouter = createSiteEventsRouter;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.PATH = `/api/${env.apiVersion}/public/site-events`;
