'use strict';

// GET /orders search, filters, sort + keyset pagination, and GET /orders/counts.

const { app, request, setupWorkspaceWithProduct, createWorkspace, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(token, workspaceId, variantId, { qty = 1, fullName = 'List Buyer', phone = '01000001111', funnelId } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `ol-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: qty }],
      contact: { fullName, phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
      paymentMethod: 'cod',
      ...(funnelId ? { funnelId } : {}),
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function createFunnel(token, workspaceId, name = 'Launch Funnel') {
  const res = await request(app).post(`/api/v1/workspaces/${workspaceId}/funnels`).set(bearer(token)).send({ name });
  if (res.status !== 201) throw new Error(`createFunnel failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.funnel;
}

const list = (token, workspaceId, query = {}) =>
  request(app).get(`/api/v1/workspaces/${workspaceId}/orders`).set(bearer(token)).query(query);
const counts = (token, workspaceId, query = {}) =>
  request(app).get(`/api/v1/workspaces/${workspaceId}/orders/counts`).set(bearer(token)).query(query);

describe('GET /orders list', () => {
  let auth, workspace, variant, token, funnel, orders;

  // setup.js truncates the DB before every test, so fixtures are rebuilt per test.
  beforeEach(async () => {
    ({ auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 100, price: 1000 }));
    token = auth.accessToken;
    funnel = await createFunnel(token, workspace.id);
    orders = [];
    // 5 orders, created in sequence: qty 1..5 → totals distinct, createdAt ascending.
    const specs = [
      { qty: 1, fullName: 'Alice Ahmed', phone: '01011112222' },
      { qty: 2, fullName: 'Bob Badr', phone: '01033334444', funnelId: funnel.id },
      { qty: 3, fullName: 'Carol Chen', phone: '01055556666' },
      { qty: 4, fullName: 'Dina Diab', phone: '01077778888', funnelId: funnel.id },
      { qty: 5, fullName: 'Eve Emad', phone: '01099990000' },
    ];
    for (const spec of specs) {
      orders.push(await placeOrder(token, workspace.id, variant.id, spec));
      // Pin createdAt one minute apart so ordering and date bounds are unambiguous.
      const i = orders.length - 1;
      await db.Order.update({ createdAt: new Date(Date.UTC(2026, 0, 1, 10, i)) }, { where: { id: orders[i].id } });
    }
    // Cancel the 3rd order (Carol).
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${orders[2].id}/cancel`)
      .set(bearer(token))
      .send({ reason: 'test cancel' })
      .expect(200);
  });

  it('defaults to newest first and paginates 3 pages of 2 without gaps or duplicates', async () => {
    const seen = [];
    let cursor;
    for (let page = 0; page < 3; page += 1) {
      const res = await list(token, workspace.id, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.orders.map((o) => o.id));
      cursor = res.body.nextCursor;
      if (page < 2) expect(cursor).toEqual(expect.any(String));
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual([...orders].reverse().map((o) => o.id));
    expect(new Set(seen).size).toBe(5);
  });

  it('sort=total_desc orders by total, and total_asc reverses it', async () => {
    const desc = await list(token, workspace.id, { sort: 'total_desc' });
    expect(desc.body.orders.map((o) => Number(o.totalAmount))).toEqual([5000, 4000, 3000, 2000, 1000]);
    const asc = await list(token, workspace.id, { sort: 'total_asc', limit: 2 });
    expect(asc.body.orders.map((o) => Number(o.totalAmount))).toEqual([1000, 2000]);
    const next = await list(token, workspace.id, { sort: 'total_asc', limit: 2, cursor: asc.body.nextCursor });
    expect(next.body.orders.map((o) => Number(o.totalAmount))).toEqual([3000, 4000]);
  });

  it('rejects a malformed cursor', async () => {
    const res = await list(token, workspace.id, { cursor: 'not-a-cursor' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('q matches order number, customer name and phone; a miss is empty', async () => {
    const byNumber = await list(token, workspace.id, { q: orders[0].orderNumber });
    expect(byNumber.body.orders.map((o) => o.id)).toEqual([orders[0].id]);

    const byName = await list(token, workspace.id, { q: 'dina' });
    expect(byName.body.orders.map((o) => o.id)).toEqual([orders[3].id]);

    const byPhone = await list(token, workspace.id, { q: '0109999' });
    expect(byPhone.body.orders.map((o) => o.id)).toEqual([orders[4].id]);

    const byPhoneWithDashes = await list(token, workspace.id, { q: '0109-9990' });
    expect(byPhoneWithDashes.body.orders.map((o) => o.id)).toEqual([orders[4].id]);

    const miss = await list(token, workspace.id, { q: 'nobody-here' });
    expect(miss.status).toBe(200);
    expect(miss.body.orders).toEqual([]);
    expect(miss.body.nextCursor).toBeNull();
  });

  it('from/to bound createdAt (inclusive from, exclusive to)', async () => {
    const res = await list(token, workspace.id, {
      from: new Date(Date.UTC(2026, 0, 1, 10, 1)).toISOString(),
      to: new Date(Date.UTC(2026, 0, 1, 10, 3)).toISOString(),
    });
    expect(res.body.orders.map((o) => o.id)).toEqual([orders[2].id, orders[1].id]);
  });

  it('source=funnel vs store, funnelId, and the funnel is embedded on each order', async () => {
    const fromFunnel = await list(token, workspace.id, { source: 'funnel' });
    expect(fromFunnel.body.orders.map((o) => o.id)).toEqual([orders[3].id, orders[1].id]);
    for (const o of fromFunnel.body.orders) {
      expect(o.funnel).toEqual({ id: funnel.id, name: 'Launch Funnel', subdomain: funnel.subdomain ?? null });
    }

    const fromStore = await list(token, workspace.id, { source: 'store' });
    expect(fromStore.body.orders.map((o) => o.id)).toEqual([orders[4].id, orders[2].id, orders[0].id]);
    expect(fromStore.body.orders[0].funnel).toBeNull();

    const byFunnelId = await list(token, workspace.id, { funnelId: funnel.id });
    expect(byFunnelId.body.orders).toHaveLength(2);
  });

  it('cancelled=true / false splits cancelled orders out', async () => {
    const yes = await list(token, workspace.id, { cancelled: true });
    expect(yes.body.orders.map((o) => o.id)).toEqual([orders[2].id]);
    const no = await list(token, workspace.id, { cancelled: false });
    expect(no.body.orders).toHaveLength(4);
    expect(no.body.orders.map((o) => o.id)).not.toContain(orders[2].id);
    const all = await list(token, workspace.id);
    expect(all.body.orders).toHaveLength(5);
  });

  it('GET /orders/counts reflects the created orders and honours filters', async () => {
    const res = await counts(token, workspace.id);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      all: 5,
      pending: 4,
      confirmed: 0,
      unreachable: 0,
      postponed: 0,
      rejected: 0,
      cancelled: 1,
      unfulfilled: 4,
      fulfilled: 0,
      returned: 0,
      unpaid: 4,
    });

    const funnelOnly = await counts(token, workspace.id, { source: 'funnel' });
    expect(funnelOnly.body.counts.all).toBe(2);
    expect(funnelOnly.body.counts.cancelled).toBe(0);

    const cancelledOnly = await counts(token, workspace.id, { cancelled: true });
    expect(cancelledOnly.body.counts).toMatchObject({ all: 1, cancelled: 1, pending: 0 });
  });

  it('never shows another workspace\'s orders', async () => {
    const other = await createWorkspace(token, 'Other Shop');
    const { variant: otherVariant } = await createProductWithVariant(token, other.id, { stock: 5 });
    const foreign = await placeOrder(token, other.id, otherVariant.id, { fullName: 'Alice Ahmed' });

    const mine = await list(token, workspace.id, { q: 'Alice' });
    expect(mine.body.orders.map((o) => o.id)).toEqual([orders[0].id]);
    const theirs = await list(token, other.id);
    expect(theirs.body.orders.map((o) => o.id)).toEqual([foreign.id]);
    expect((await counts(token, workspace.id)).body.counts.all).toBe(5);
  });
});
