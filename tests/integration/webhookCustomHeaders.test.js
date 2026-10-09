'use strict';

// Custom headers per webhook endpoint (webhooks/customHeaders.js, STORE_FEATURES webhook_headers):
// sealed, shown masked, sent with every delivery under our own headers, never replacing them.

const http = require('http');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({ headers: req.headers });
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/hooks`, received, close: () => new Promise((done) => server.close(done)) }));
  });
}

let receiver;
beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  env.storeFeatures.length = 0;
  await receiver.close();
});

const headers = [{ name: 'X-Api-Key', value: 'k-123456789' }, { name: 'Authorization', value: 'Bearer abc' }];

describe('webhook custom headers', () => {
  it('off: nothing is stored or sent', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const created = await request(app).post(`/api/v1/workspaces/${workspace.id}/webhooks`).set(bearer(auth.accessToken)).send({ url: receiver.url, events: ['order.created'], customHeaders: headers });
    expect(created.status).toBe(201);
    expect(created.body.endpoint.customHeaders).toBeUndefined();
    expect((await db.WebhookEndpoint.findByPk(created.body.endpoint.id)).customHeaders).toEqual([]);

    await request(app).post(`/api/v1/workspaces/${workspace.id}/webhooks/${created.body.endpoint.id}/test`).set(bearer(auth.accessToken));
    expect(receiver.received[0].headers['x-api-key']).toBeUndefined();
  });

  it('on: sealed, shown masked, sent with each delivery; ours cannot be replaced; keep holds a stored value', async () => {
    env.storeFeatures.push('webhook_headers');
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const base = `/api/v1/workspaces/${workspace.id}/webhooks`;

    const reserved = await request(app).post(base).set(bearer(auth.accessToken)).send({ url: receiver.url, events: ['order.created'], customHeaders: [{ name: 'X-Zimos-Event', value: 'x' }] });
    expect(reserved.status).toBe(422);
    const arabic = await request(app).post(base).set(bearer(auth.accessToken)).send({ url: receiver.url, events: ['order.created'], customHeaders: [{ name: 'X-Note', value: 'مرحبا' }] });
    expect(arabic.status).toBe(422);

    const created = await request(app).post(base).set(bearer(auth.accessToken)).send({ url: receiver.url, events: ['order.created'], customHeaders: headers });
    expect(created.status).toBe(201);
    const { id } = created.body.endpoint;
    expect(created.body.endpoint.customHeaders.map((h) => h.name)).toEqual(['X-Api-Key', 'Authorization']);
    expect(JSON.stringify(created.body)).not.toContain('k-123456789');
    const stored = (await db.WebhookEndpoint.findByPk(id)).customHeaders;
    expect(JSON.stringify(stored)).not.toContain('k-123456789');

    // Keep the key, drop Authorization, add one.
    const updated = await request(app).patch(`${base}/${id}`).set(bearer(auth.accessToken)).send({ customHeaders: [{ name: 'X-Api-Key', keep: true }, { name: 'X-Tenant', value: 'shop-7' }] });
    expect(updated.status).toBe(200);

    await request(app).post(`${base}/${id}/test`).set(bearer(auth.accessToken));
    const [hit] = receiver.received;
    expect(hit.headers['x-api-key']).toBe('k-123456789');
    expect(hit.headers['x-tenant']).toBe('shop-7');
    expect(hit.headers.authorization).toBeUndefined();
    expect(hit.headers['x-zimos-event']).toBe('webhook.test');
  });
});
