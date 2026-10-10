'use strict';

// Outbound order webhooks, end to end: a real HTTP receiver on loopback,
// orders changed through the ordinary dashboard and public-API paths, and
// the webhook pass (webhookWorker.runOnce) driven by hand the way the
// in-process loop and scripts/dispatch-webhooks.js drive it.

const http = require('http');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const { runOnce } = require('../../src/modules/webhooks/webhookWorker');
const { verifySignature } = require('../../src/modules/webhooks/webhookSigning');
const { MAX_ATTEMPTS } = require('../../src/modules/webhooks/webhookDispatcher');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const minutes = (n) => n * 60 * 1000;

function startReceiver() {
  const received = [];
  let answer = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.statusCode = answer;
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/zimos/hooks`,
        received,
        answer: (status) => {
          answer = status;
        },
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

let receiver;
beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `o-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Hook Buyer', phone: '01000004444' },
      shippingAddress: { country: 'EG', city: 'Giza', addressLine: '3 Pyramids Rd' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

// The two order topics these tests are about; '*' now also brings order.confirmed and the other topics.
async function addEndpoint(token, workspaceId, { events = ['order.created', 'order.status_changed'], url = receiver.url } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/webhooks`)
    .set(bearer(token))
    .send({ url, events });
  if (res.status !== 201) throw new Error(`addEndpoint failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('webhook endpoints', () => {
  it('shows the signing secret on creation and rotation only, and refuses URLs that are not http(s)', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { endpoint, signingSecret } = await addEndpoint(auth.accessToken, workspace.id, { events: ['order.created'] });
    expect(signingSecret).toMatch(/^whsec_/);
    expect(endpoint.secretHint).toBe(`whsec_…${signingSecret.slice(-4)}`);

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/webhooks`).set(bearer(auth.accessToken));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(signingSecret);
    expect(list.body.events.map((e) => e.name)).toEqual(expect.arrayContaining(['order.created', 'order.status_changed']));

    const rotated = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}/rotate-secret`)
      .set(bearer(auth.accessToken));
    expect(rotated.status).toBe(200);
    expect(rotated.body.signingSecret).not.toBe(signingSecret);

    const ftp = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/webhooks`)
      .set(bearer(auth.accessToken))
      .send({ url: 'ftp://example.com/hooks', events: ['*'] });
    expect(ftp.status).toBe(422);

    const badEvent = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/webhooks`)
      .set(bearer(auth.accessToken))
      .send({ url: receiver.url, events: ['order.exploded'] });
    expect(badEvent.status).toBe(422);
  });

  it('sends a signed test event on demand and reports how the receiver answered', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { endpoint, signingSecret } = await addEndpoint(auth.accessToken, workspace.id);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}/test`)
      .set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.delivery).toMatchObject({ eventType: 'webhook.test', status: 'delivered', lastResponseStatus: 200 });

    expect(receiver.received).toHaveLength(1);
    const [hit] = receiver.received;
    expect(hit.headers['x-zimos-event']).toBe('webhook.test');
    expect(hit.headers['user-agent']).toBe('Zimos-Webhooks/1.0');
    expect(verifySignature(signingSecret, hit.headers['x-zimos-signature'], hit.body)).toBe(true);
    expect(verifySignature('whsec_wrong', hit.headers['x-zimos-signature'], hit.body)).toBe(false);
  });
});

describe('order events', () => {
  it('sends order.created, then order.status_changed with previous and current, and nothing when nothing changed', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const { signingSecret } = await addEndpoint(auth.accessToken, workspace.id);
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    await runOnce();
    expect(receiver.received.map((r) => r.json.type)).toEqual(['order.created']);
    const created = receiver.received[0];
    expect(verifySignature(signingSecret, created.headers['x-zimos-signature'], created.body)).toBe(true);
    expect(created.headers['x-zimos-event-id']).toBe(`order.created:${order.id}`);
    expect(created.json).toMatchObject({
      id: `order.created:${order.id}`,
      type: 'order.created',
      workspaceId: workspace.id,
      data: {
        order: { id: order.id, orderNumber: order.orderNumber, stage: 'pending_confirmation' },
        current: { stage: 'pending_confirmation', confirmationState: 'pending' },
      },
    });

    // Nothing moved: another pass sends nothing.
    await runOnce();
    expect(receiver.received).toHaveLength(1);

    // Confirmed from the dashboard — the webhook module is never told; it notices.
    await confirmCodOrder(auth.accessToken, workspace.id, order.id);
    await runOnce();
    expect(receiver.received).toHaveLength(2);
    const changed = receiver.received[1].json;
    expect(changed.type).toBe('order.status_changed');
    expect(changed.data.previous).toMatchObject({ stage: 'pending_confirmation', confirmationState: 'pending' });
    expect(changed.data.current).toMatchObject({ stage: 'ready_to_ship', confirmationState: 'confirmed' });
    expect(changed.data.changed).toEqual(expect.arrayContaining(['stage', 'confirmationState']));
    expect(changed.data.order.confirmationState).toBe('confirmed');
  });

  it("notices a shipment moving even though the order row itself didn't change", async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await addEndpoint(auth.accessToken, workspace.id, { events: ['order.status_changed'] });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await confirmCodOrder(auth.accessToken, workspace.id, order.id);
    const shipment = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'Sharks Fulfilment', waybillNumber: 'SH-77' });
    expect(shipment.status).toBe(201);
    const shipmentUrl = `/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${shipment.body.shipment.id}`;
    // In transit first: the order's fulfilment becomes partially_fulfilled,
    // so the order row itself changes here.
    await request(app).patch(shipmentUrl).set(bearer(auth.accessToken)).send({ status: 'in_transit' });
    await runOnce();
    receiver.received.length = 0;
    // Make the order row's last write old news — outside the minute every
    // pass re-reads — so only the shipment can bring the order back into view.
    await db.sequelize.query("UPDATE orders SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = :id", {
      replacements: { id: order.id },
    });
    const orderTouchedAt = (await db.Order.findByPk(order.id)).updatedAt.getTime();

    // In transit -> out for delivery: still partially_fulfilled, so only the
    // shipment row moves — the order row is untouched.
    await request(app).patch(shipmentUrl).set(bearer(auth.accessToken)).send({ status: 'out_for_delivery' });
    expect((await db.Order.findByPk(order.id)).updatedAt.getTime()).toBe(orderTouchedAt);
    await runOnce();

    expect(receiver.received).toHaveLength(1);
    const { data } = receiver.received[0].json;
    expect(data.current).toMatchObject({ stage: 'out_for_delivery', shipmentStatus: 'out_for_delivery' });
    expect(data.changed).toEqual(expect.arrayContaining(['shipmentStatus']));
    expect(data.order.shipments[0]).toMatchObject({ waybillNumber: 'SH-77', status: 'out_for_delivery' });
  });

  it('only sends the events an endpoint subscribed to', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await addEndpoint(auth.accessToken, workspace.id, { events: ['order.created'] });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await runOnce();
    await confirmCodOrder(auth.accessToken, workspace.id, order.id);
    await runOnce();
    expect(receiver.received.map((r) => r.json.type)).toEqual(['order.created']);
  });

  it('tells an endpoint about an order from before it existed as a status change with no previous state', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    // The endpoint is created strictly later than the order.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await addEndpoint(auth.accessToken, workspace.id);
    await confirmCodOrder(auth.accessToken, workspace.id, order.id);
    await runOnce();

    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0].json.type).toBe('order.status_changed');
    expect(receiver.received[0].json.data.previous).toBeNull();
    expect(receiver.received[0].json.data.current.confirmationState).toBe('confirmed');
  });

  it('sends nothing for a paused endpoint', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const { endpoint } = await addEndpoint(auth.accessToken, workspace.id);
    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}`)
      .set(bearer(auth.accessToken))
      .send({ isActive: false });
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    await runOnce();
    expect(receiver.received).toHaveLength(0);
    expect(await db.WebhookDelivery.count()).toBe(0);
  });

  it("never sends one store's orders to another store's endpoint", async () => {
    const a = await setupWorkspaceWithProduct();
    const b = await setupWorkspaceWithProduct();
    await addEndpoint(a.auth.accessToken, a.workspace.id);
    await placeOrder(b.auth.accessToken, b.workspace.id, b.variant.id);
    await runOnce();
    expect(receiver.received).toHaveLength(0);
  });
});

describe('delivery retries', () => {
  it('retries a failed delivery on the backoff schedule with the same event id, until the receiver accepts it', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const { endpoint } = await addEndpoint(auth.accessToken, workspace.id, { events: ['order.created'] });
    receiver.answer(500);
    await placeOrder(auth.accessToken, workspace.id, variant.id);

    const start = new Date();
    await runOnce({ now: start });
    let delivery = await db.WebhookDelivery.findOne({ where: { endpointId: endpoint.id } });
    expect(delivery).toMatchObject({ status: 'failed', attemptCount: 1, lastResponseStatus: 500 });
    expect(delivery.lastError).toBe('Receiver answered HTTP 500');
    expect(delivery.nextAttemptAt.getTime()).toBe(start.getTime() + minutes(1));

    // Not due yet: nothing is sent.
    await runOnce({ now: new Date(start.getTime() + 30 * 1000) });
    expect(receiver.received).toHaveLength(1);

    receiver.answer(204);
    await runOnce({ now: new Date(start.getTime() + minutes(2)) });
    delivery = await delivery.reload();
    expect(delivery).toMatchObject({ status: 'delivered', attemptCount: 2, lastResponseStatus: 204, lastError: null });
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[1].headers['x-zimos-event-id']).toBe(receiver.received[0].headers['x-zimos-event-id']);
  });

  it('gives up after the last attempt, and a redeliver sends it again', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const { endpoint } = await addEndpoint(auth.accessToken, workspace.id, { events: ['order.created'] });
    receiver.answer(503);
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    await runOnce();

    const delivery = await db.WebhookDelivery.findOne({ where: { endpointId: endpoint.id } });
    await delivery.update({ attemptCount: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) });
    await runOnce();
    await delivery.reload();
    expect(delivery).toMatchObject({ status: 'exhausted', attemptCount: MAX_ATTEMPTS, nextAttemptAt: null });

    receiver.answer(200);
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}/deliveries/${delivery.id}/redeliver`)
      .set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.delivery.status).toBe('delivered');

    const history = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}/deliveries`)
      .set(bearer(auth.accessToken));
    expect(history.body.deliveries).toHaveLength(1);
    expect(history.body.deliveries[0]).toMatchObject({ eventType: 'order.created', status: 'delivered' });
  });

  it('records an unreachable receiver as a failure to retry, not a crash', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const { endpoint } = await addEndpoint(auth.accessToken, workspace.id, { events: ['order.created'] });
    await receiver.close();
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    await runOnce();
    const delivery = await db.WebhookDelivery.findOne({ where: { endpointId: endpoint.id } });
    expect(delivery.status).toBe('failed');
    expect(delivery.lastResponseStatus).toBeNull();
    expect(delivery.lastError).toMatch(/ECONNREFUSED|connect/i);
    receiver = await startReceiver(); // afterEach closes it
  });
});

describe('the order change scanner', () => {
  const { scanOnce } = require('../../src/modules/webhooks/orderChangeDetector');

  it('reads its whole window page by page when more orders changed than one batch holds', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    await addEndpoint(auth.accessToken, workspace.id, { events: ['order.created'] });
    await db.WebhookScanCursor.destroy({ where: {} });

    for (let i = 0; i < 5; i += 1) await placeOrder(auth.accessToken, workspace.id, variant.id);

    // A batch of 2 holds fewer than the 5 orders changed inside the overlap.
    const now = new Date(Date.now() + 1000);
    const pass = await scanOnce({ now, limit: 2 });
    expect(pass.events).toBe(5);
    expect(pass.scanned).toBe(5);
    expect(pass.pages).toBe(3);
    expect(await db.WebhookDelivery.count({ where: { workspaceId: workspace.id, eventType: 'order.created' } })).toBe(5);
    // The cursor moves to now, past the window, whatever the batch size.
    expect((await db.WebhookScanCursor.findOne()).scannedUntil.getTime()).toBe(now.getTime());

    // A second pass re-reads the overlap and makes nothing new.
    const again = await scanOnce({ now: new Date(now.getTime() + 1000), limit: 2 });
    expect(again.events).toBe(0);
  });
});
