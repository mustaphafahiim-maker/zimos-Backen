'use strict';

// The console adding credit to a store's prepaid balance at any time: a gift
// (adds only) or a correction (either way, as before), with a reason, an
// audit entry and, when asked, a note in the store's bell. Neither is ever
// refundable. The store's panel shows each paid top-up's ceiling, what was
// refunded or is held, and what is left.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');

let admin;
let feePlan;

beforeEach(async () => {
  env.wallet.enabled = true;
  admin = await makePlatformUser('creator');
  feePlan = await db.Plan.create({
    key: `payg-credit-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Pay per order',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    currency: 'EGP',
    isActive: true,
    perOrderFeeAmount: 400,
  });
});

afterEach(() => {
  env.wallet.enabled = false;
});

async function store() {
  const setup = await setupWorkspaceWithProduct({ stock: 1 });
  const wid = setup.workspace.id;
  const far = new Date();
  far.setUTCFullYear(far.getUTCFullYear() + 50);
  await db.Subscription.update({ planId: feePlan.id, status: 'active', currentPeriodEnd: far, trialEndsAt: null }, { where: { workspaceId: wid } });
  return { wid, H: { Authorization: `Bearer ${setup.auth.accessToken}` } };
}

const credit = (wid, body) =>
  request(app)
    .post(`/api/v1/admin/workspaces/${wid}/wallet/adjustments`)
    .set(admin.H)
    .send({ reason: 'Sorry for the outage', requestId: crypto.randomUUID(), ...body });
const panel = async (wid) => (await request(app).get(`/api/v1/admin/workspaces/${wid}/wallet`).set(admin.H)).body;
const bell = (wid) => db.MerchantNotification.findAll({ where: { workspaceId: wid, type: 'wallet.credit' } });

describe('credit from the console', () => {
  it('a gift adds, is audited, is never refundable, and tells the store only when asked', async () => {
    const s = await store();
    let res = await credit(s.wid, { amount: 25000, kind: 'gift', notifyMerchant: true });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ type: 'gift', amount: 25000 });
    expect(await bell(s.wid)).toHaveLength(1);
    res = await credit(s.wid, { amount: 5000, kind: 'gift' });
    expect(res.status).toBe(201);
    expect(await bell(s.wid)).toHaveLength(1);

    expect((await credit(s.wid, { amount: -100, kind: 'gift' })).body.error.code).toBe('GIFT_MUST_ADD');
    // A correction stays as it was: either way, an adjustment entry.
    res = await credit(s.wid, { amount: -2000 });
    expect(res.body.entry).toMatchObject({ type: 'adjustment', amount: -2000 });

    const p = await panel(s.wid);
    expect(p.wallet.balance).toBe(28000);
    expect(p.refunds).toMatchObject({ topups: [], lifetimeToppedUp: 0, refundable: 0, refunded: 0, pending: 0, ceilingBp: 7500 });
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'wallet.gift' } })).toBe(2);
    const refund = await request(app).get(`/api/v1/workspaces/${s.wid}/billing/wallet/refunds`).set(s.H);
    expect(refund.body.quote).toMatchObject({ balance: 28000, max: 0, canRequest: false });
  });

  it('the store panel shows each paid top-up with its ceiling, held, refunded and what is left', async () => {
    const s = await store();
    const proof = { id: crypto.randomUUID(), workspaceId: s.wid, methodCode: 'instapay' };
    await db.sequelize.transaction((t) => wallet.creditTopup(proof, 100000, null, t));
    const first = await request(app)
      .post(`/api/v1/workspaces/${s.wid}/billing/wallet/refunds`)
      .set(s.H)
      .send({ amount: 30000 });
    await request(app).post(`/api/v1/admin/wallet-refunds/${first.body.request.id}/approve`).set(admin.H).send({});
    await request(app).post(`/api/v1/admin/wallet-refunds/${first.body.request.id}/mark-paid`).set(admin.H).send({ payoutReference: 'IPA-9' });
    await request(app).post(`/api/v1/workspaces/${s.wid}/billing/wallet/refunds`).set(s.H).send({ amount: 10000 });

    const p = await panel(s.wid);
    expect(p.refunds.topups).toEqual([
      expect.objectContaining({ amount: 100000, ceiling: 75000, refunded: 30000, held: 10000, remaining: 35000, source: 'transfer' }),
    ]);
    expect(p.refunds).toMatchObject({ lifetimeToppedUp: 100000, refundable: 35000, refunded: 30000, pending: 10000 });
    expect(p.wallet.balance).toBe(60000);
  });
});
