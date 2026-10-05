'use strict';

// What keeps outbound webhooks from being turned against our own network,
// and what lets a receiver trust them.

const env = require('../../src/config/env');
const { checkUrl, isPrivateAddress, guardedLookup } = require('../../src/modules/webhooks/webhookUrlGuard');
const { signatureHeader, verifySignature } = require('../../src/modules/webhooks/webhookSigning');

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.10',
    '169.254.169.254', // cloud metadata service
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
  ])('refuses %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '41.33.12.4', '2606:4700:4700::1111'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('checkUrl in production (no private URLs)', () => {
  let saved;
  beforeEach(() => {
    saved = env.webhooks.allowPrivateUrls;
    env.webhooks.allowPrivateUrls = false;
  });
  afterEach(() => {
    env.webhooks.allowPrivateUrls = saved;
  });

  it('accepts a public https URL', () => {
    expect(checkUrl('https://hooks.example.com/zimos')).toBe('https://hooks.example.com/zimos');
  });

  it.each([
    ['http://hooks.example.com/zimos', /https/],
    ['https://user:pass@hooks.example.com/', /username/],
    ['https://localhost/hooks', /public hostname/],
    ['https://db.internal/hooks', /public hostname/],
    ['https://10.0.0.5/hooks', /public address/],
    ['https://169.254.169.254/latest/meta-data', /public address/],
    ['https://[::1]/hooks', /public address/],
    ['https://intranet/hooks', /public hostname/],
    ['not a url', /full URL/],
  ])('refuses %s', (url, why) => {
    let error;
    try {
      checkUrl(url);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(422);
    expect(error.details[0].message).toMatch(why);
  });

  it('refuses at connect time a hostname that resolves to a private address', (done) => {
    guardedLookup('localhost', {}, (err) => {
      expect(err && err.code).toBe('EWEBHOOKBLOCKED');
      done();
    });
  });
});

describe('signatures', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt', type: 'order.created' });
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const t = Math.floor(now / 1000);

  it('verifies a fresh, untouched request', () => {
    expect(verifySignature(secret, signatureHeader(secret, t, body), body, { now })).toBe(true);
  });

  it('rejects a changed body, a different secret and an old timestamp', () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignature(secret, header, `${body} `, { now })).toBe(false);
    expect(verifySignature('whsec_other', header, body, { now })).toBe(false);
    expect(verifySignature(secret, header, body, { now: now + 10 * 60 * 1000 })).toBe(false);
    expect(verifySignature(secret, 'garbage', body, { now })).toBe(false);
  });
});
