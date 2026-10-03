'use strict';

// The orders list and the confirmation queue sorted on the server (every sort
// paged to the end with a small page, nothing skipped or repeated), when an
// order was confirmed (orders.confirmed_at, set, cleared and backfilled), and
// the payment method + gateway each order row carries.

const crypto = require('crypto');
const { Sequelize } = require('sequelize');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const confirmedAtMigration = require('../../src/db/migrations/115-add-confirmed-at-to-orders');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const contact = { fullName: 'Karim Fathy', phone: '01098765432' };
const address = { country: 'EG', province: 'Giza', city: 'Dokki', addressLine: '5 Tahrir Street' };

async function setup() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 500 });
  const ws = ctx.workspace.id;
  return {
    ...ctx,
    ws,
    api: (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(ctx.auth.accessToken)),
  };
}

async function staffOrder(ctx, quantity, paymentMethod = 'cod') {
  const res = await ctx
    .api('post', '/orders')
    .set('Idempotency-Key', `sort-${crypto.randomUUID()}`)
    .send({ items: [{ variantId: ctx.variant.id, quantity }], contact, shippingAddress: address, paymentMethod });
  if (res.status !== 201) throw new Error(`order: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

/**
 * Five orders with two ties on purpose — two share a created_at, two share a
 * total — so the id tie-breaker has something to decide.
 */
async function fiveOrders(ctx) {
  const quantities = [3, 1, 5, 3, 4];
  const base = Date.UTC(2026, 8, 1, 9, 0, 0);
  const minutes = [0, 10, 10, 30, 40];
  const orders = [];
  for (const [i, quantity] of quantities.entries()) {
    const order = await staffOrder(ctx, quantity);
    const createdAt = new Date(base + minutes[i] * 60000);
    await db.sequelize.query('UPDATE orders SET created_at = $1 WHERE id = $2', { bind: [createdAt, order.id] });
    orders.push({ id: order.id, createdAt: createdAt.getTime(), total: Number(order.totalAmount) });
  }
  return orders;
}

/** What each sort must return: by (key, id), both in the sort's direction. */
function expected(orders, sort) {
  const [field, dir] = {
    newest: ['createdAt', -1],
    oldest: ['createdAt', 1],
    total_desc: ['total', -1],
    total_asc: ['total', 1],
  }[sort];
  return [...orders]
    .sort((a, b) => (a[field] !== b[field] ? (a[field] - b[field]) * dir : (a.id < b.id ? -1 : 1) * dir))
    .map((o) => o.id);
}

async function walk(fetchPage) {
  const ids = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const { items, nextCursor } = await fetchPage(cursor);
    ids.push(...items);
    if (!nextCursor) return ids;
    cursor = nextCursor;
  }
  throw new Error('walk: more pages than expected');
}

describe('orders list sort', () => {
  it('sorts every way on the server and pages through all of it', async () => {
    const ctx = await setup();
    const orders = await fiveOrders(ctx);

    for (const sort of ['newest', 'oldest', 'total_desc', 'total_asc']) {
      const ids = await walk(async (cursor) => {
        const res = await ctx.api('get', `/orders?limit=2&sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        return { items: res.body.orders.map((o) => o.id), nextCursor: res.body.nextCursor };
      });
      expect({ sort, ids }).toEqual({ sort, ids: expected(orders, sort) });
    }
  });

  it('keeps newest first as the default and refuses an unknown sort', async () => {
    const ctx = await setup();
    const orders = await fiveOrders(ctx);
    const plain = await ctx.api('get', '/orders?limit=50');
    expect(plain.body.orders.map((o) => o.id)).toEqual(expected(orders, 'newest'));

    for (const bad of ['created_at', 'total_amount DESC', 'random']) {
      const res = await ctx.api('get', `/orders?sort=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(422);
    }
  });

  it('sorts the stage tabs too', async () => {
    const ctx = await setup();
    const orders = await fiveOrders(ctx);
    const res = await ctx.api('get', '/orders?stage=pending_confirmation&sort=total_asc');
    expect(res.body.orders.map((o) => o.id)).toEqual(expected(orders, 'total_asc'));
  });
});

describe('confirmation queue sort', () => {
  it('sorts a tab by its orders and pages through it; default stays the tab order', async () => {
    const ctx = await setup();
    const orders = await fiveOrders(ctx);
    const taskOf = new Map(
      (await db.ConfirmationTask.findAll({ where: { workspaceId: ctx.ws } })).map((t) => [t.orderId, t.id])
    );

    for (const sort of ['newest', 'oldest', 'total_desc', 'total_asc']) {
      const orderIds = await walk(async (cursor) => {
        const res = await ctx.api('get', `/confirmation-tasks?status=pending&limit=2&sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        return { items: res.body.tasks.map((t) => t.order.id), nextCursor: res.body.nextCursor };
      });
      // Ties between orders break on the task id, so compare as order ids
      // only where the order key differs; the multiset is always complete.
      expect(new Set(orderIds)).toEqual(new Set(orders.map((o) => o.id)));
      expect(orderIds).toHaveLength(5);
      const keyOf = (id) => {
        const o = orders.find((x) => x.id === id);
        return sort.startsWith('total') ? o.total : o.createdAt;
      };
      const keys = orderIds.map(keyOf);
      const desc = sort === 'newest' || sort === 'total_desc';
      for (let i = 1; i < keys.length; i += 1) {
        if (desc) expect(keys[i]).toBeLessThanOrEqual(keys[i - 1]);
        else expect(keys[i]).toBeGreaterThanOrEqual(keys[i - 1]);
        // equal keys: task ids in the sort's direction
        if (keys[i] === keys[i - 1]) {
          const [a, b] = [taskOf.get(orderIds[i - 1]), taskOf.get(orderIds[i])];
          expect(desc ? a > b : a < b).toBe(true);
        }
      }
    }

    const byDefault = await ctx.api('get', '/confirmation-tasks?status=pending&limit=50');
    const explicit = await ctx.api('get', '/confirmation-tasks?status=pending&limit=50&sort=default');
    expect(byDefault.body.tasks.map((t) => t.id)).toEqual(explicit.body.tasks.map((t) => t.id));

    const bad = await ctx.api('get', '/confirmation-tasks?status=pending&sort=t.id');
    expect(bad.status).toBe(422);
  });
});

describe('orders.confirmed_at', () => {
  it('is stamped on confirmation, cleared by a correction to rejected and restamped after', async () => {
    const ctx = await setup();
    const order = await staffOrder(ctx, 1);
    expect(order.confirmedAt).toBeNull();

    const before = Date.now();
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, order.id);
    const detail = (await ctx.api('get', `/orders/${order.id}`)).body.order;
    expect(new Date(detail.confirmedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const listed = (await ctx.api('get', '/orders')).body.orders.find((o) => o.id === order.id);
    expect(listed.confirmedAt).toBe(detail.confirmedAt);

    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    const rejected = await ctx
      .api('post', `/confirmation-tasks/${task.id}/correction`)
      .send({ outcome: 'rejected', reason: 'Customer called back' });
    expect(rejected.status).toBe(200);
    expect((await db.Order.findByPk(order.id)).confirmedAt).toBeNull();

    const again = await ctx
      .api('post', `/confirmation-tasks/${task.id}/correction`)
      .send({ outcome: 'confirmed', reason: 'Changed their mind again' });
    expect(again.status).toBe(200);
    const restamped = (await db.Order.findByPk(order.id)).confirmedAt;
    expect(restamped).not.toBeNull();
    expect(restamped.getTime()).toBeGreaterThanOrEqual(new Date(detail.confirmedAt).getTime());
  });

  it('comes with the task in the queue after a queue call', async () => {
    const ctx = await setup();
    const order = await staffOrder(ctx, 1);
    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    await ctx.api('post', `/confirmation-tasks/${task.id}/claim`).send({});
    const done = await ctx.api('post', `/confirmation-tasks/${task.id}/outcome`).send({ outcome: 'confirmed' });
    expect(done.status).toBe(200);
    expect(done.body.task.order.confirmedAt).not.toBeNull();
  });

  it('is backfilled from the audit log, then from confirmation tasks, and left null otherwise', async () => {
    const ctx = await setup();
    const fromAudit = await staffOrder(ctx, 1);
    const fromTask = await staffOrder(ctx, 1);
    const pending = await staffOrder(ctx, 1);
    const flipped = await staffOrder(ctx, 1);
    for (const o of [fromAudit, fromTask, flipped]) await confirmCodOrder(ctx.auth.accessToken, ctx.ws, o.id);
    const flippedTask = await db.ConfirmationTask.findOne({ where: { orderId: flipped.id } });
    await ctx.api('post', `/confirmation-tasks/${flippedTask.id}/correction`).send({ outcome: 'rejected', reason: 'No' });

    // History as it really happened: move the audit row and the task stamp
    // apart from "now" so each source is recognisable.
    const auditAt = new Date('2026-09-02T08:15:00.000Z');
    const taskAt = new Date('2026-09-03T11:45:00.000Z');
    await db.sequelize.query(
      `UPDATE audit_logs SET created_at = $1
        WHERE entity_id = $2 AND action = 'order.confirmation_state_change'`,
      { bind: [auditAt, fromAudit.id] }
    );
    // No audit trail for this one: the task's completion is all there is.
    await db.sequelize.query(`DELETE FROM audit_logs WHERE entity_id = $1 AND action = 'order.confirmation_state_change'`, {
      bind: [fromTask.id],
    });
    await db.sequelize.query('UPDATE confirmation_tasks SET completed_at = $1 WHERE order_id = $2', {
      bind: [taskAt, fromTask.id],
    });

    const qi = db.sequelize.getQueryInterface();
    await confirmedAtMigration.down(qi, Sequelize);
    expect((await qi.describeTable('orders')).confirmed_at).toBeUndefined();
    await confirmedAtMigration.up(qi, Sequelize);

    const at = async (id) => (await db.Order.findByPk(id)).confirmedAt;
    expect((await at(fromAudit.id)).toISOString()).toBe(auditAt.toISOString());
    expect((await at(fromTask.id)).toISOString()).toBe(taskAt.toISOString());
    expect(await at(pending.id)).toBeNull();
    expect(await at(flipped.id)).toBeNull();
  });
});

describe('payment method on the list', () => {
  it('carries the method and, for an online order, the gateway of its latest attempt', async () => {
    const ctx = await setup();
    const cod = await staffOrder(ctx, 1);
    const card = await staffOrder(ctx, 1, 'card');
    await db.Payment.create({
      workspaceId: ctx.ws,
      orderId: card.id,
      providerCode: 'paymob',
      method: 'card',
      mode: 'live',
      status: 'initialized',
      amount: card.totalAmount,
      currency: 'EGP',
      providerOrderId: '777001',
    });
    const list = (await ctx.api('get', '/orders')).body.orders;
    expect(list.find((o) => o.id === cod.id)).toMatchObject({ paymentMethod: 'cod', paymentProvider: null });
    expect(list.find((o) => o.id === card.id)).toMatchObject({ paymentMethod: 'card', paymentProvider: 'paymob' });
    const detail = (await ctx.api('get', `/orders/${card.id}`)).body.order;
    expect(detail.paymentProvider).toBe('paymob');
  });
});
