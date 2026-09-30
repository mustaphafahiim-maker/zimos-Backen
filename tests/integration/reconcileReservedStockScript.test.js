'use strict';

// scripts/reconcile-reserved-stock.js: works out each variant's reserved stock
// from the orders holding it, reports the ones that differ, and corrects them
// only with --apply (one stock movement per correction).

const path = require('path');
const { execFileSync } = require('child_process');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const SCRIPT = path.join(__dirname, '../../scripts/reconcile-reserved-stock.js');
const run = (args) =>
  execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const nextPhone = () => `0103${String(1000000 + (seq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '9 Count Street' };

const reserved = async (variantId) => (await db.ProductVariant.findByPk(variantId)).reservedStock;

it('reports differences in a dry run and corrects them only with --apply', async () => {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
  const ws = ctx.workspace.id;
  const api = (method, p) => request(app)[method](`/api/v1/workspaces/${ws}${p}`).set(bearer(ctx.auth.accessToken));
  const b = await api('post', `/catalog/products/${ctx.product.id}/variants`).send({ sku: `RB-${Date.now()}`, priceAmount: 9000, stockOnHand: 50 });
  const A = ctx.variant.id;
  const B = b.body.variant.id;
  const bundle = (await api('post', `/catalog/products/${ctx.product.id}/offers`).send({
    name: 'A + 2 B',
    priceAmount: 20000,
    lines: [
      { variantId: A, quantity: 1 },
      { variantId: B, quantity: 2 },
    ],
  })).body.offer;
  const place = async (items) => {
    const res = await api('post', '/orders')
      .set('Idempotency-Key', `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({ items, contact: { fullName: 'Count Buyer', phone: nextPhone() }, shippingAddress: ADDRESS, paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    return res.body.order;
  };

  // Live: a bundle order and a plain one. Gone: a cancelled bundle order.
  await place([{ variantId: A, offerId: bundle.id, quantity: 2 }]); // A 2, B 4
  await place([{ variantId: B, quantity: 1 }]); // B 1
  const cancelled = await place([{ variantId: A, offerId: bundle.id, quantity: 1 }]);
  expect((await api('post', `/orders/${cancelled.id}/cancel`).send({ reason: 'x' })).status).toBe(200);
  // An order from before reservations named their order: rebuilt from its lines.
  const legacy = await place([{ variantId: A, offerId: bundle.id, quantity: 1 }]); // A 1, B 2
  await db.InventoryMovement.update({ referenceId: null }, { where: { referenceId: legacy.id, referenceType: 'order_pending' } });

  expect({ A: await reserved(A), B: await reserved(B) }).toEqual({ A: 3, B: 7 });
  // Everything in line: nothing to report.
  expect(run(['--workspace', ws])).toMatch(/0 off/);

  // What the old releases left behind: A kept 2 units too many, B gave back one too many.
  await db.ProductVariant.update({ reservedStock: 5 }, { where: { id: A } });
  await db.ProductVariant.update({ reservedStock: 6 }, { where: { id: B } });

  const dry = run(['--workspace', ws]);
  expect(dry).toMatch(/DRY RUN/);
  expect(dry).toContain(`${A}`);
  expect(dry).toMatch(/reserved 5, expected 3 \(-2\)/);
  expect(dry).toMatch(/reserved 6, expected 7 \(\+1\)/);
  expect(dry).toMatch(/1 too high, 1 too low/);
  expect({ A: await reserved(A), B: await reserved(B) }).toEqual({ A: 5, B: 6 });

  const applied = run(['--workspace', ws, '--apply', '--batch', '1']);
  expect(applied).toMatch(/2 corrected, 0 failed/);
  expect({ A: await reserved(A), B: await reserved(B) }).toEqual({ A: 3, B: 7 });
  const moves = await db.InventoryMovement.findAll({ where: { workspaceId: ws, referenceType: 'reserved_stock_reconcile' } });
  expect(moves.map((m) => [m.variantId, m.type, m.reservedDelta]).sort()).toEqual(
    [
      [A, 'release', -2],
      [B, 'reserve', 1],
    ].sort()
  );

  expect(run(['--workspace', ws])).toMatch(/0 off/);
}, 60000);
