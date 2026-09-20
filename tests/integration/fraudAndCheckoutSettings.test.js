'use strict';

// Merchant fraud rules enforced on storefront orders, the flagged-orders /
// blocklist endpoints, and checkout form settings enforced by the backend.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function shopperCheckout(workspaceId, variantId, overrides = {}) {
  return request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `fr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      contact: { fullName: 'Rule Buyer', phone: '01077778888', ...(overrides.contact || {}) },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '4 Test St' },
      paymentMethod: 'cod',
      item: { variantId, quantity: 1 },
      ...(overrides.body || {}),
    });
}

const setSettings = (auth, workspaceId, settings) =>
  request(app).patch(`/api/v1/workspaces/${workspaceId}`).set(bearer(auth.accessToken)).send({ settings });

describe('fraud rules', () => {
  it('flags duplicate orders and lists them; approving clears the flags', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    await setSettings(auth, workspace.id, { fraud_rules: { action: 'flag', duplicate_window_minutes: 60 } }).expect(200);

    const first = await shopperCheckout(workspace.id, variant.id);
    expect(first.status).toBe(201);
    expect(first.body.order.riskFlags).toEqual([]);
    const second = await shopperCheckout(workspace.id, variant.id);
    expect(second.status).toBe(201);
    expect(second.body.order.riskFlags).toContain('duplicate_order');

    const flagged = await request(app).get(`/api/v1/workspaces/${workspace.id}/fraud/flagged-orders`).set(bearer(auth.accessToken));
    expect(flagged.status).toBe(200);
    expect(flagged.body.orders.map((o) => o.id)).toEqual([second.body.order.id]);

    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/fraud/flagged-orders/${second.body.order.id}/approve`)
      .set(bearer(auth.accessToken))
      .expect(200);
    const after = await request(app).get(`/api/v1/workspaces/${workspace.id}/fraud/flagged-orders`).set(bearer(auth.accessToken));
    expect(after.body.orders).toHaveLength(0);
  });

  it('blocks a blocklisted phone when the merchant chose to block', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/fraud/blocklist`)
      .set(bearer(auth.accessToken))
      .send({ phone: '01077778888', reason: 'Repeated fake orders' })
      .expect(201);
    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/fraud/blocklist`).set(bearer(auth.accessToken));
    expect(list.body.entries).toHaveLength(1);

    // Default (no rules): allowed but flagged.
    const flaggedOnly = await shopperCheckout(workspace.id, variant.id);
    expect(flaggedOnly.status).toBe(201);
    expect(flaggedOnly.body.order.riskFlags).toContain('blacklisted_customer');

    await setSettings(auth, workspace.id, { fraud_rules: { action: 'flag', block_blacklisted: true } }).expect(200);
    const blocked = await shopperCheckout(workspace.id, variant.id);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('ORDER_BLOCKED');
  });

  it('never applies rules to orders the merchant creates', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    await setSettings(auth, workspace.id, { fraud_rules: { action: 'block', max_orders_per_phone_per_day: 1 } }).expect(200);
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(bearer(auth.accessToken))
        .set('Idempotency-Key', `staff-${i}-${Date.now()}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: 'Phone Order', phone: '01077778888' },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '5 Test St' },
          paymentMethod: 'cod',
        });
      expect(res.status).toBe(201);
    }
    const shopper = await shopperCheckout(workspace.id, variant.id);
    expect(shopper.status).toBe(422);
  });
});

describe('checkout settings', () => {
  it('are exposed on the store and enforced at checkout', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    await setSettings(auth, workspace.id, { checkout_settings: { email: 'required', allow_discount_codes: false, thank_you_message: 'شكرًا ليك' } }).expect(200);

    const store = await request(app).get(`/api/v1/store/${workspace.id}`);
    expect(store.body.store.checkout).toMatchObject({ email: 'required', allowDiscountCodes: false, thankYouMessage: 'شكرًا ليك', notes: 'optional' });

    const noEmail = await shopperCheckout(workspace.id, variant.id, { contact: { phone: '01099990000' } });
    expect(noEmail.status).toBe(422);

    const withEmail = await shopperCheckout(workspace.id, variant.id, {
      contact: { phone: '01099990000', email: 'buyer@example.com' },
      body: { discountCode: 'IGNORED' },
    });
    expect(withEmail.status).toBe(201);
  });
});
