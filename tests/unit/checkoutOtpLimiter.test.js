'use strict';

const express = require('express');
const request = require('supertest');
const storefrontRoutes = require('../../src/modules/storefront/storefrontRoutes');
const { checkoutOtpLimiter, CHECKOUT_OTP_PER_MINUTE, createIpMinuteLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

// The checkout code step (risk/checkoutOtp): verify and Resend share one
// per-IP budget a minute, on top of the per-code and per-phone limits.
const handlersOf = (path) => {
  const layer = storefrontRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  return layer ? layer.route.stack.map((s) => s.handle) : [];
};

describe('checkout code limiter', () => {
  it('guards both POST /checkout/otp/verify and /checkout/otp/resend', () => {
    expect(handlersOf('/checkout/otp/verify')).toContain(checkoutOtpLimiter);
    expect(handlersOf('/checkout/otp/resend')).toContain(checkoutOtpLimiter);
    expect(CHECKOUT_OTP_PER_MINUTE).toBe(10);
  });

  it('a limiter built the same way answers 429 past its budget, per IP', async () => {
    // Every limiter is skipped under NODE_ENV=test, so this builds one without that skip.
    const small = express();
    small.set('trust proxy', 1);
    small.post('/otp', createIpMinuteLimiter('test-checkout-otp', 2), (req, res) => res.json({ ok: true }));
    small.use(errorHandler);
    const from = (ip) => request(small).post('/otp').set('X-Forwarded-For', ip);
    expect([(await from('198.51.100.40')).status, (await from('198.51.100.40')).status, (await from('198.51.100.40')).status]).toEqual([200, 200, 429]);
    expect((await from('198.51.100.41')).status).toBe(200);
  });
});
