'use strict';

// COD settlements: delivered, unsettled COD orders are listed per courier; a
// settlement records cash collected and fees; confirming it records captured
// payments and marks the orders paid; an order can only be settled once.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function deliveredOrder(auth, workspaceId, variantId, carrierCode = 'manual') {
  const order = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(auth.accessToken))
    .set('Idempotency-Key', `st-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Settle Buyer', phone: '01033334444' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '7 Test St' },
      paymentMethod: 'cod',
    });
  if (order.status !== 201) throw new Error(`order failed ${order.status} ${JSON.stringify(order.body)}`);
  // A COD order is confirmed before a courier can be booked for it.
  await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${order.body.order.id}/confirmation`)
    .set(bearer(auth.accessToken))
    .send({})
    .expect(200);
  const ship = await request(app).post(`/api/v1/workspaces/${workspaceId}/orders/${order.body.order.id}/shipments`).set(bearer(auth.accessToken)).send({ carrierCode });
  await request(app)
    .patch(`/api/v1/workspaces/${workspaceId}/orders/${order.body.order.id}/shipments/${ship.body.shipment.id}`)
    .set(bearer(auth.accessToken))
    .send({ status: 'delivered' })
    .expect(200);
  return order.body.order;
}

describe('COD settlements', () => {
  it('settles delivered COD orders, records payments and never settles an order twice', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 30000, stock: 20 });
    const a = await deliveredOrder(auth, workspace.id, variant.id, 'manual');
    const b = await deliveredOrder(auth, workspace.id, variant.id, 'manual');
    await deliveredOrder(auth, workspace.id, variant.id, 'aramex');

    const unsettled = await request(app).get(`/api/v1/workspaces/${workspace.id}/settlements/unsettled`).set(bearer(auth.accessToken));
    expect(unsettled.status).toBe(200);
    expect(unsettled.body.orders).toHaveLength(3);
    const manual = unsettled.body.carriers.find((c) => c.carrierCode === 'manual');
    expect(manual.orders).toBe(2);

    const created = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/settlements`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'manual', reference: 'BOSTA-STMT-1', lines: [{ orderId: a.id, feeAmount: 3000 }, { orderId: b.id, feeAmount: 3000 }] });
    expect(created.status).toBe(201);
    const s = created.body.settlement;
    expect(s).toMatchObject({ status: 'draft', feesAmount: 6000 });
    expect(s.netAmount).toBe(s.collectedAmount - 6000);

    const twice = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/settlements`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'manual', lines: [{ orderId: a.id }] });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe('ORDER_NOT_SETTLEABLE');

    const confirmed = await request(app).post(`/api/v1/workspaces/${workspace.id}/settlements/${s.id}/confirm`).set(bearer(auth.accessToken));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.settlement.status).toBe('confirmed');
    expect(confirmed.body.settlement.lines.every((l) => l.financialState === 'paid')).toBe(true);

    const order = await request(app).get(`/api/v1/workspaces/${workspace.id}/orders/${a.id}`).set(bearer(auth.accessToken));
    expect(order.body.order.financialState).toBe('paid');

    const locked = await request(app).delete(`/api/v1/workspaces/${workspace.id}/settlements/${s.id}`).set(bearer(auth.accessToken));
    expect(locked.status).toBe(409);

    const summary = await request(app).get(`/api/v1/workspaces/${workspace.id}/settlements/summary`).set(bearer(auth.accessToken));
    expect(summary.body.summary).toMatchObject({ unsettledOrders: 1, courierFees: 6000, draftSettlements: 0 });
    expect(summary.body.summary.received).toBe(s.netAmount);
  });
});
