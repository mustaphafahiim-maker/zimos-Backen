'use strict';

// webhookSender.send resolves, never rejects: a header value Node refuses is a
// failed attempt like any other, so it cannot stop a delivery batch.

const { send } = require('../../src/modules/webhooks/webhookSender');

describe('webhookSender.send', () => {
  it('a header value HTTP cannot carry is a failed attempt, not a rejection', async () => {
    const result = await send({ url: 'https://hooks.example.com/zimos', body: '{}', headers: { 'X-Api-Key': 'كلمة' }, timeoutMs: 1000 });
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/invalid character/i);
  });

  it('a malformed URL is a failed attempt too', async () => {
    await expect(send({ url: 'not a url', body: '{}', headers: {}, timeoutMs: 1000 })).resolves.toEqual({ status: null, error: 'Invalid URL' });
  });
});
