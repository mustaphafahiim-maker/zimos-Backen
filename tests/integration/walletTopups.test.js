'use strict';

// Topping up the prepaid balance by a manual transfer: the proof flow of
// payment_proofs with purpose 'topup' (billing/paymentProofService), credited
// by walletService.creditTopup with what the console saw arrive.
//
//   POST /workspaces/:id/billing/wallet/topups    multipart
//   GET  /workspaces/:id/billing/wallet, /wallet/ledger
//   POST /admin/payment-proofs/:id/approve | /reject
//   GET  /admin/workspaces/:id/wallet

const sharp = require('sharp');
const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');

beforeEach(async () => {
  env.wallet.enabled = true;
  await db.PaymentMethod.bulkCreate([
    { kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' },
    { kind: 'manual', code: 'wallet', labelAr: 'محفظة إلكترونية', labelEn: 'Mobile wallet', sortOrder: 20, enabled: true, accountNumber: '01000000001' },
  ]);
});

afterEach(() => {
  env.wallet.enabled = false;
});

let shade = 0;
async function screenshot() {
  shade += 1;
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 30, g: shade % 256, b: (shade * 3) % 256 } } })
    .png()
    .toBuffer();
}

async function newStore(name = 'Topping Store') {
  const owner = await registerAndActivate({ fullName: 'Hany Samir' });
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const res = await request(app).post('/api/v1/workspaces').set(H).send({ name });
  if (res.status !== 201) throw new Error(`store: ${res.status} ${JSON.stringify(res.body)}`);
  return { wid: res.body.workspace.id, H };
}

async function topup(store, { requestedAmount = 50000, methodCode = 'instapay', senderPhone = '01112345678', file } = {}) {
  const req = request(app).post(`/api/v1/workspaces/${store.wid}/billing/wallet/topups`).set(store.H);
  if (requestedAmount !== null) req.field('requestedAmount', String(requestedAmount));
  req.field('methodCode', methodCode).field('senderPhone', senderPhone);
  req.attach('file', file || (await screenshot()), { filename: 'transfer.png', contentType: 'image/png' });
  return req;
}

const approve = (admin, id, receivedAmount) => request(app).post(`/api/v1/admin/payment-proofs/${id}/approve`).set(admin.H).send({ receivedAmount });
const balance = async (store) => (await request(app).get(`/api/v1/workspaces/${store.wid}/billing/wallet`).set(store.H)).body.wallet;

describe('asking for a top-up', () => {
  it('is closed while WALLET_ENABLED is off', async () => {
    env.wallet.enabled = false;
    const store = await newStore();
    const res = await topup(store);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_DISABLED');
    expect(await db.PaymentProof.count()).toBe(0);
  });

  it(`takes ${wallet.MIN_TOPUP_AMOUNT} to ${wallet.MAX_TOPUP_AMOUNT} (minor units), and nothing outside`, async () => {
    const store = await newStore();
    for (const requestedAmount of [wallet.MIN_TOPUP_AMOUNT - 1, wallet.MAX_TOPUP_AMOUNT + 1, 0]) {
      const res = await topup(store, { requestedAmount });
      expect([422]).toContain(res.status);
      if (requestedAmount > 0) {
        expect(res.body.error.code).toBe('TOPUP_AMOUNT_OUT_OF_RANGE');
        expect(res.body.error.details).toMatchObject({ min: 10000, max: 2000000, currency: 'EGP' });
      }
    }
    expect((await topup(store, { requestedAmount: wallet.MIN_TOPUP_AMOUNT })).status).toBe(201);
    const top = await topup(store, { requestedAmount: wallet.MAX_TOPUP_AMOUNT });
    expect(top.status).toBe(201);
    expect(top.body.proof).toMatchObject({ purpose: 'topup', invoiceId: null, amount: wallet.MAX_TOPUP_AMOUNT, currency: 'EGP', status: 'pending' });
  });

  it(`keeps at most ${wallet.MAX_OPEN_TOPUPS} waiting`, async () => {
    const store = await newStore();
    for (let i = 0; i < wallet.MAX_OPEN_TOPUPS; i += 1) expect((await topup(store)).status).toBe(201);
    const res = await topup(store);
    expect(res.status).toBe(409);
    expect(['TOO_MANY_OPEN_TOPUPS', 'TOO_MANY_OPEN_PROOFS']).toContain(res.body.error.code);
  });
});

describe('approving a top-up', () => {
  it('credits what arrived, even when it differs from what was asked, once', async () => {
    const store = await newStore();
    const sent = await topup(store, { requestedAmount: 50000 });
    const admin = await makePlatformUser('admin');
    const review = await request(app).get(`/api/v1/admin/payment-proofs/${sent.body.proof.id}`).set(admin.H);
    expect(review.body).toMatchObject({ proof: { purpose: 'topup', requestedAmount: 50000 }, invoice: null, wallet: { balance: 0 } });

    const res = await approve(admin, sent.body.proof.id, 45000);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyApproved: false, proof: { status: 'approved', requestedAmount: 50000, receivedAmount: 45000 } });
    expect(await balance(store)).toMatchObject({ balance: 45000, totalToppedUp: 45000 });

    const again = await approve(admin, sent.body.proof.id, 45000);
    expect(again.status).toBe(200);
    expect(again.body.alreadyApproved).toBe(true);
    expect(await balance(store)).toMatchObject({ balance: 45000 });

    const ledger = await request(app).get(`/api/v1/workspaces/${store.wid}/billing/wallet/ledger`).set(store.H);
    expect(ledger.body.entries).toEqual([
      expect.objectContaining({ type: 'topup', amount: 45000, balanceAfter: 45000, paymentProofId: sent.body.proof.id }),
    ]);
    const audit = await db.AuditLog.findOne({ where: { action: 'payment_proof.approve' } });
    expect(audit.metadata).toMatchObject({ purpose: 'topup', requestedAmount: 50000, receivedDiffers: true });
  });

  it('needs an amount that arrived; nothing arrived is a rejection', async () => {
    const store = await newStore();
    const sent = await topup(store);
    const admin = await makePlatformUser('admin');
    const res = await approve(admin, sent.body.proof.id, 0);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RECEIVED_AMOUNT_REQUIRED');
    const rejected = await request(app).post(`/api/v1/admin/payment-proofs/${sent.body.proof.id}/reject`).set(admin.H).send({ note: 'Nothing arrived.' });
    expect(rejected.status).toBe(200);
    expect(await balance(store)).toMatchObject({ balance: 0 });
  });
});

describe('another store', () => {
  it('sees neither the top-ups nor the balance of another', async () => {
    const a = await newStore();
    const b = await newStore('Other Store');
    const sent = await topup(a);
    const admin = await makePlatformUser('admin');
    await approve(admin, sent.body.proof.id, 50000);

    const crossed = await request(app).get(`/api/v1/workspaces/${a.wid}/billing/wallet`).set(b.H);
    expect([403, 404]).toContain(crossed.status);
    const crossedTopup = await request(app)
      .post(`/api/v1/workspaces/${a.wid}/billing/wallet/topups`)
      .set(b.H)
      .field('requestedAmount', '50000')
      .field('methodCode', 'instapay')
      .field('senderPhone', '01112345678')
      .attach('file', await screenshot(), { filename: 't.png', contentType: 'image/png' });
    expect([403, 404]).toContain(crossedTopup.status);
    expect((await balance(b)).balance).toBe(0);
    expect((await request(app).get(`/api/v1/workspaces/${b.wid}/billing/payment-proofs`).set(b.H)).body.proofs).toHaveLength(0);
  });
});

describe('the console’s balance panel', () => {
  it('shows a store’s balance and ledger to subscriptions.view, not to an agent', async () => {
    const store = await newStore();
    const sent = await topup(store);
    const admin = await makePlatformUser('admin');
    await approve(admin, sent.body.proof.id, 50000);
    const res = await request(app).get(`/api/v1/admin/workspaces/${store.wid}/wallet`).set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toMatchObject({ balance: 50000, totalToppedUp: 50000, onFeePlan: false });
    expect(res.body.ledger.entries).toHaveLength(1);
    const agent = await makePlatformUser('agent');
    expect((await request(app).get(`/api/v1/admin/workspaces/${store.wid}/wallet`).set(agent.H)).status).toBe(403);
  });

  it('the merchant’s summary has the limits and this month in Cairo', async () => {
    const store = await newStore();
    const summary = await balance(store);
    expect(summary).toMatchObject({
      enabled: true,
      balance: 0,
      onFeePlan: false,
      month: { fees: 0, orders: 0, timeZone: 'Africa/Cairo' },
      limits: { minTopup: 10000, maxTopup: 2000000, maxOpenTopups: 3, lowOrders: 20 },
      overdraft: 1000,
    });
  });
});
