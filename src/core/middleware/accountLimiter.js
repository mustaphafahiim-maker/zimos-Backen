'use strict';

// Counters are shared through Redis when REDIS_URL is set (rateLimitStore.js).
const rateLimit = require('./rateLimitStore').withSharedStore(require('express-rate-limit'));
const env = require('../../config/env');
const { RateLimitError } = require('../errors/AppError');

/*
 * Changes to a signed-in account (auth/accountService: name, username,
 * email, phone; Ziad's 7c061ba, item 332), limited per ACCOUNT, not per IP:
 * in production many people can share one IP, and these routes always know
 * who is asking. Mounted after `authenticate`. Skipped under tests, like the
 * other limiters.
 */
const ACCOUNT_CHANGES_PER_HOUR = 20;

const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: ACCOUNT_CHANGES_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  keyGenerator: (req) => `account:${req.user.id}`,
  handler: (req, res, next) => next(new RateLimitError()),
});

module.exports = { ACCOUNT_CHANGES_PER_HOUR, accountLimiter };
