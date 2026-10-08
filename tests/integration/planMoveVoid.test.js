'use strict';

// A plan move never traps a store (migration 224): an unpaid move leaves the
// store exactly as it was; the merchant cancels it, another move replaces
// it, or it expires after WALLET_MOVE_EXPIRY_HOURS; its charge is then void
// (not due, not owed). Money that still arrives for it is applied when the
// move still can be, otherwise credited to the balance once.
//
//   POST /workspaces/:id/billing/plan-move, /plan-move/cancel
//   billing job: merchantPlansService.expirePendingMoves

const sharp = require('sharp');
const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const plans = require('../../src/modules/billing/merchantPlansService');
const { accessFor } = require('../../src/modules/workspaces/workspaceAccessService');
const ledgerCheck = require('../../scripts/check-wallet-ledger');

const STARTER = 30000;

let feePlan;
let starter;
let pro;
let admin;

beforeEach(async () => {
  env.wallet.enabled = true;
  feePlan = await db.Plan.create({ key: 'pay-per-order', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true, perOrderFeeAmount: 400 });
  starter = await db.Plan.create({ key: 'starter', name: 'Starter', monthlyPriceAmount: STARTER, yearlyPriceAmount: STARTER * 10, currency: 'EGP', isPublic: true, isActive: true });
  pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000, currency: 'EGP', isPublic: true, isActive: true });
  await db.PaymentMethod.create({ kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' });
  admin = await makePlatformUser('creator');
});

afterEach(() => {
  env.wallet.enabled = false;
});

async function payPerOrderStore() {
  const setup = await setupWorkspaceWithProduct({ stock: 5 });
  const wid = setup.workspace.id;
  const H = { Authorization: `Bearer ${setup.auth.accessToken}` };
  await db.Subscription.update({ status: 'trialing', trialEndsAt: new Date(Date.now() + 86400000) }, { where: { workspaceId: wid } });
  const chosen = await request(app).post(`/api/v1/workspaces/${wid}/billing/pay-per-order`).set(H).send({});
  if (chosen.status !== 200) throw new Error(`pay-per-order: ${chosen.status}`);
  return { wid, H };
}

const move = (s, body) => request(app).post(`/api/v1/workspaces/${s.wid}/billing/plan-move`).set(s.H).send(body);
const cancel = (s) => request(app).post(`/api/v1/workspaces/${s.wid}/billing/plan-move/cancel`).set(s.H).send({});
const subscriptionOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid }, raw: true });
const invoice = (id) => db.BillingInvoice.findByPk(id);
const recordPayment = (id, amount = STARTER) => request(app).post(`/api/v1/admin/charges/${id}/record-payment`).set(admin.H).send({ amountReceived: amount });

let shade = 0;
async function proof(s, invoiceId) {
  shade += 1;
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: shade % 256, g: 40, b: 90 } } }).png().toBuffer();
  return request(app)
    .post(`/api/v1/workspaces/${s.wid}/billing/invoices/${invoiceId}/payment-proofs`)
    .set(s.H)
    .field('methodCode', 'instapay')
    .field('senderPhone', '01012345678')
    .attach('file', png, { filename: 'shot.png', contentType: 'image/png' });
}

describe('an unpaid move', () => {
  it('leaves the store exactly as it was, and the merchant cancels it; nothing is owed after', async () => {
    const s = await payPerOrderStore();
    const before = await subscriptionOf(s.wid);
    const asked = await move(s, { planId: starter.id });
    expect(asked.status).toBe(201);
    expect(await subscriptionOf(s.wid)).toEqual(before);

    const res = await cancel(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cancelled: true, plans: { move: { pending: null } } });
    expect(await invoice(asked.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'cancelled' });
    expect(await subscriptionOf(s.wid)).toEqual(before);
    // Not owed: no pending charge, no restriction, nothing on the balance.
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);
    expect((await accessFor(s.wid)).reasons).toEqual([]);
    const list = await request(app).get(`/api/v1/workspaces/${s.wid}/billing/invoices`).set(s.H);
    expect(list.body.invoices[0]).toMatchObject({ status: 'void', voidReason: 'cancelled' });
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.plan_move_void' } })).toBe(1);

    // Again: nothing to cancel; and a new move can start at once.
    expect((await cancel(s)).body.cancelled).toBe(false);
    expect((await move(s, { planId: pro.id })).status).toBe(201);
  });

  it('another plan replaces the waiting move in one go; the same plan again is the same charge', async () => {
    const s = await payPerOrderStore();
    const first = await move(s, { planId: starter.id });
    expect((await move(s, { planId: starter.id })).body.invoice.id).toBe(first.body.invoice.id);
    const second = await move(s, { planId: pro.id, billingCycle: 'yearly' });
    expect(second.status).toBe(201);
    expect(await invoice(first.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(await invoice(second.body.invoice.id)).toMatchObject({ status: 'pending', targetPlanId: pro.id });
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(1);
  });

  it('expires after WALLET_MOVE_EXPIRY_HOURS through the billing job, only with WALLET_ENABLED, and only moves', async () => {
    const s = await payPerOrderStore();
    const asked = await move(s, { planId: starter.id });
    // A real charge of another store, just as old: never touched.
    const other = await setupWorkspaceWithProduct({ stock: 1 });
    const otherSub = await db.Subscription.findOne({ where: { workspaceId: other.workspace.id } });
    await db.Subscription.update({ planId: starter.id, status: 'active' }, { where: { id: otherSub.id } });
    const renewal = await require('../../src/modules/billing/subscriptionChargeService').createCharge(other.workspace.id);
    const old = new Date(Date.now() - (env.wallet.moveExpiryHours + 1) * 3600 * 1000);
    await db.sequelize.query('UPDATE billing_invoices SET created_at = $old WHERE id IN ($a, $b)', { bind: { old, a: asked.body.invoice.id, b: renewal.invoice.id } });

    env.wallet.enabled = false;
    expect(await plans.expirePendingMoves()).toEqual({ expired: 0 });
    env.wallet.enabled = true;
    const job = require('../../src/modules/billing/jobs').schedules.find((j) => j.name === 'billing.expire_plan_moves');
    expect(await job.handle()).toEqual({ expired: 1 });
    expect(await invoice(asked.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'expired' });
    expect((await invoice(renewal.invoice.id)).status).toBe('pending');
    expect(await plans.expirePendingMoves()).toEqual({ expired: 0 });
  });

  it('a real pending charge still blocks a move, and cancelling leaves it alone', async () => {
    const s = await payPerOrderStore();
    const sub = await db.Subscription.findOne({ where: { workspaceId: s.wid } });
    const charge = await db.BillingInvoice.create({
      workspaceId: s.wid,
      subscriptionId: sub.id,
      grossAmount: 5000,
      discountAmount: 0,
      amount: 5000,
      currency: 'EGP',
      status: 'pending',
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86400000),
    });
    const res = await move(s, { planId: starter.id });
    expect([res.status, res.body.error.code]).toEqual([409, 'OPEN_CHARGE_EXISTS']);
    expect((await cancel(s)).body.cancelled).toBe(false);
    expect((await invoice(charge.id)).status).toBe('pending');
  });
});

describe('money that arrives after a move was voided', () => {
  it('a transfer approved later applies the move when it still can', async () => {
    const s = await payPerOrderStore();
    const asked = await move(s, { planId: starter.id });
    const sent = await proof(s, asked.body.invoice.id);
    expect(sent.status).toBe(201);
    await cancel(s);
    const approved = await request(app).post(`/api/v1/admin/payment-proofs/${sent.body.proof.id}/approve`).set(admin.H).send({ receivedAmount: STARTER });
    expect(approved.status).toBe(200);
    expect(await invoice(asked.body.invoice.id)).toMatchObject({ status: 'paid', voidReason: null });
    expect(await subscriptionOf(s.wid)).toMatchObject({ planId: starter.id, status: 'active' });
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.plan_move_late_applied' } })).toBe(1);
  });

  it('is credited to the balance, once, when the move can no longer be applied', async () => {
    const s = await payPerOrderStore();
    const asked = await move(s, { planId: starter.id });
    await cancel(s);
    await db.Plan.update({ isPublic: false }, { where: { id: starter.id } });

    expect((await recordPayment(asked.body.invoice.id)).status).toBe(200);
    expect((await recordPayment(asked.body.invoice.id)).status).toBe(200);
    const credits = await db.WalletLedgerEntry.findAll({ where: { workspaceId: s.wid, entryType: 'move_payment_credit' } });
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].cashDelta)).toBe(STARTER);
    expect(await subscriptionOf(s.wid)).toMatchObject({ planId: feePlan.id });
    expect(await invoice(asked.body.invoice.id)).toMatchObject({ status: 'void', amountPaid: String(STARTER) });
    // Not a top-up: nothing of it is refundable by request.
    const { quote } = (await request(app).get(`/api/v1/workspaces/${s.wid}/billing/wallet/refunds`).set(s.H)).body;
    expect(quote).toMatchObject({ balance: STARTER, refundableFromTopups: 0, max: 0 });
    for (const row of await ledgerCheck.check()) expect(ledgerCheck.problemsOf(row)).toEqual([]);
  });

  it('a replaced move paid late is credited: the store has another move waiting', async () => {
    const s = await payPerOrderStore();
    const first = await move(s, { planId: starter.id });
    await move(s, { planId: pro.id });
    expect((await recordPayment(first.body.invoice.id)).status).toBe(200);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: s.wid, entryType: 'move_payment_credit' } })).toBe(1);
    expect((await subscriptionOf(s.wid)).planId).toBe(feePlan.id);
  });
});
