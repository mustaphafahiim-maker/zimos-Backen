'use strict';

// A per-IP limit on the account endpoints that a new email doesn't get round.

const express = require('express');
const { request } = require('../helpers/factories');
const { createAuthIpLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

describe('the per-IP limit on the account endpoints', () => {
  // Every limiter is skipped under NODE_ENV=test (rateLimiters' `skip`), so
  // these build a small one from the same factory, without that skip.
  function limitedApp(options) {
    const small = express();
    small.set('trust proxy', 1);
    small.use(express.json());
    small.post('/auth', createAuthIpLimiter({ windowMs: 60 * 1000, prefix: 'test-auth-ip', ...options }), (req, res) =>
      req.body.password === 'right' ? res.json({ ok: true }) : res.status(401).json({ ok: false })
    );
    small.use(errorHandler);
    return small;
  }
  const from = (target, ip, body) => request(target).post('/auth').set('X-Forwarded-For', ip).send(body);

  it('counts the IP whatever email each request sends, and not other IPs', async () => {
    const small = limitedApp({ max: 3 });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await from(small, '198.51.100.20', { email: `new${i}@example.com`, password: 'right' })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await from(small, '198.51.100.21', { email: 'other@example.com', password: 'right' })).status).toBe(200);
  });

  it('for sign-in, counts failed attempts only', async () => {
    const small = limitedApp({ max: 2, failedOnly: true });
    const ip = '198.51.100.22';
    for (let i = 0; i < 5; i += 1) {
      expect((await from(small, ip, { email: `ok${i}@example.com`, password: 'right' })).status).toBe(200);
    }
    const failures = [];
    for (let i = 0; i < 3; i += 1) {
      failures.push((await from(small, ip, { email: `guess${i}@example.com`, password: 'wrong' })).status);
    }
    expect(failures).toEqual([401, 401, 429]);
  });
});
