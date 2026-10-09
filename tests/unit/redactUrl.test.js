'use strict';

const { redactUrl } = require('../../src/core/utils/redactUrl');

// Request URLs written to the log (core/utils/redactUrl): secrets in the path
// or the query come out as [redacted].
describe('redactUrl', () => {
  it('hides the token of a storefront link that is a secret in itself', () => {
    expect(redactUrl('/api/v1/store/ws-1/recover/abc123def?x=1')).toBe('/api/v1/store/ws-1/recover/[redacted]?x=1');
    expect(redactUrl('/api/v1/store/ws-1/downloads/tok-9/file')).toBe('/api/v1/store/ws-1/downloads/[redacted]/file');
    expect(redactUrl('/api/v1/store/ws-1/subscriptions/tok-7/cancel')).toBe('/api/v1/store/ws-1/subscriptions/[redacted]/cancel');
  });

  it('keeps the order download path, which carries an order id, not a token', () => {
    expect(redactUrl('/api/v1/store/ws-1/downloads/order/ord-1')).toBe('/api/v1/store/ws-1/downloads/order/ord-1');
  });

  it("hides the Google callback's code and the inbox stream ticket", () => {
    expect(redactUrl('/api/v1/auth/google/callback?code=4/0AbC&state=s1')).toBe('/api/v1/auth/google/callback?code=[redacted]&state=s1');
    expect(redactUrl('/api/v1/workspaces/w/whatsapp/inbox/stream?ticket=t.k.n')).toBe('/api/v1/workspaces/w/whatsapp/inbox/stream?ticket=[redacted]');
  });

  it('still hides the webhook tokens and gateway signatures as before', () => {
    expect(redactUrl('/api/v1/webhooks/payments/paymob/secret-token?hmac=abc')).toBe('/api/v1/webhooks/payments/paymob/[redacted]?hmac=[redacted]');
    expect(redactUrl('/api/v1/store/ws-1/products?page=2')).toBe('/api/v1/store/ws-1/products?page=2');
  });
});
