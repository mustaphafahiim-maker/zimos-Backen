'use strict';

// Abandoned-checkout recovery: the storefront records a session once a phone is
// typed, staff see it after 30 minutes of inactivity, follow up, and a later
// real order converts it (recovered when the merchant had reached out).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const PHONE = '01055556666';

const saveSession = (workspaceId, body) => request(app).post(`/api/v1/store/${workspaceId}/checkout-sessions`).send(body);

describe('checkout sessions', () => {
  it('needs a phone or email', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    const res = await saveSession(workspace.id, { contact: { fullName: 'No Contact' }, items: [] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONTACT_REQUIRED');
  });

  it('prices items from the catalogue, lists as abandoned, follows up and converts on order', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 15000, stock: 10 });

    const first = await saveSession(workspace.id, { contact: { fullName: 'Lost Shopper', phone: PHONE }, items: [{ variantId: variant.id, quantity: 2 }] });
    expect(first.status).toBe(201);
    // Same phone again updates the same session instead of creating a duplicate.
    const again = await saveSession(workspace.id, { contact: { fullName: 'Lost Shopper', phone: '+20 105 555 6666' }, items: [{ variantId: variant.id, quantity: 3 }] });
    expect(again.body.session.id).toBe(first.body.session.id);

    // Not abandoned yet (still active).
    const early = await request(app).get(`/api/v1/workspaces/${workspace.id}/checkout-sessions`).set(bearer(auth.accessToken));
    expect(early.body.sessions).toHaveLength(0);

    await db.CheckoutSession.update({ lastActivityAt: new Date(Date.now() - 60 * 60 * 1000) }, { where: { id: first.body.session.id } });
    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/checkout-sessions`).set(bearer(auth.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0]).toMatchObject({ status: 'abandoned', customerName: 'Lost Shopper', subtotalAmount: 45000, recoveryStatus: 'not_contacted' });
    expect(list.body.sessions[0].items[0]).toMatchObject({ quantity: 3, lineTotalAmount: 45000 });

    const contacted = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/checkout-sessions/${first.body.session.id}`)
      .set(bearer(auth.accessToken))
      .send({ recoveryStatus: 'contacted' });
    expect(contacted.status).toBe(200);
    expect(contacted.body.session.contactedAt).toBeTruthy();

    const order = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', `cs-${Date.now()}`)
      .send({
        contact: { fullName: 'Lost Shopper', phone: PHONE },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '3 Test St' },
        paymentMethod: 'cod',
        item: { variantId: variant.id, quantity: 1 },
      });
    expect(order.status).toBe(201);

    const converted = await request(app).get(`/api/v1/workspaces/${workspace.id}/checkout-sessions`).query({ view: 'converted' }).set(bearer(auth.accessToken));
    expect(converted.body.sessions).toHaveLength(1);
    expect(converted.body.sessions[0]).toMatchObject({ status: 'converted', recoveryStatus: 'recovered', convertedOrder: { orderNumber: order.body.order.orderNumber } });
  });
});
