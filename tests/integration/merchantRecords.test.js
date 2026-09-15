'use strict';

// Media library, merchant billing overview, audit log, invoices and call-center
// stats — read endpoints added so the dashboard has no local/mock data.

const path = require('path');
const fs = require('fs');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
// Smallest valid PNG (1×1).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `mr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Records Buyer', phone: '01022223333' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '2 Test St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('media library', () => {
  it('records uploads, lists them newest first and deletes from the library', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const up = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', PNG, 'dot.png');
    expect(up.status).toBe(201);
    expect(up.body.id).toBeTruthy();

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/media`).set(bearer(auth.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.media).toHaveLength(1);
    expect(list.body.media[0]).toMatchObject({ id: up.body.id, url: up.body.url, mimeType: 'image/png' });

    const del = await request(app).delete(`/api/v1/workspaces/${workspace.id}/media/${up.body.id}`).set(bearer(auth.accessToken));
    expect(del.status).toBe(200);
    const after = await request(app).get(`/api/v1/workspaces/${workspace.id}/media`).set(bearer(auth.accessToken));
    expect(after.body.media).toHaveLength(0);

    // Clean the file this test wrote to local storage.
    const local = path.join(__dirname, '../../public', up.body.path || '');
    if (up.body.path && fs.existsSync(local)) fs.unlinkSync(local);
  });
});

describe('merchant billing, audit log and invoices', () => {
  it('shows the workspace subscription with plan and usage', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/billing`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.billing.subscription.status).toBe('trialing');
    expect(res.body.billing.usage.ordersThisPeriod).toBe(1);
    expect(Array.isArray(res.body.billing.plans)).toBe(true);
    expect(res.body.billing.gatewayConnected).toBe(false);
  });

  it('lists audit entries with the actor', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/audit-logs`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThan(0);
    expect(res.body.logs.some((l) => l.actor && l.actor.email === auth.email)).toBe(true);
  });

  it('lists invoices (empty until one is issued)', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/invoices`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.invoices)).toBe(true);
  });
});

describe('call center stats', () => {
  it('lists attempts and agents from real confirmation activity', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    await request(app).post(`/api/v1/workspaces/${workspace.id}/confirmation-tasks/${task.id}/claim`).set(bearer(auth.accessToken)).expect(200);
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/confirmation-tasks/${task.id}/outcome`)
      .set(bearer(auth.accessToken))
      .send({ outcome: 'confirmed', notes: 'ok' })
      .expect(200);

    const attempts = await request(app).get(`/api/v1/workspaces/${workspace.id}/confirmation-tasks/attempts`).set(bearer(auth.accessToken));
    expect(attempts.status).toBe(200);
    expect(attempts.body.attempts).toHaveLength(1);
    expect(attempts.body.attempts[0]).toMatchObject({ outcome: 'confirmed', order: { orderNumber: order.orderNumber } });

    const agents = await request(app).get(`/api/v1/workspaces/${workspace.id}/confirmation-tasks/agents`).set(bearer(auth.accessToken));
    expect(agents.status).toBe(200);
    const me = agents.body.agents.find((a) => a.email === auth.email);
    expect(me).toMatchObject({ attempts: 1, confirmed: 1, confirmationRate: 100 });
  });
});
