'use strict';

// Platform-wide risk: the admin blocklist (/admin/risk/blocklist), which
// refuses order creation in every workspace, and the cross-workspace fraud
// signals (/admin/risk/signals).

const { app, request, registerAndActivate, createWorkspace, setupWorkspaceWithProduct, setPlatformRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { storedOrder } = require('../helpers/storedOrder');
const env = require('../../src/config/env');
const { REJECTION_MESSAGE } = require('../../src/modules/fraud/fraudRules');
const fakePaymob = require('../helpers/fakePaymob');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `pr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const PHONE = '01055550001';
const ADDRESS = { country: 'EG', city: 'Cairo', addressLine: '12 Tahrir St.' };

async function setupAdmin() {
  const auth = await registerAndActivate();
  await setPlatformRole(auth.userId, 'admin');
  return { userId: auth.userId, H: bearer(auth.accessToken) };
}

async function setupPlain() {
  const auth = await registerAndActivate();
  await createWorkspace(auth.accessToken, 'Plain Co');
  return { H: bearer(auth.accessToken) };
}

function storefrontOrder(ctx, { phone = PHONE, email, shippingAddress = ADDRESS } = {}) {
  return request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Risk Test Buyer', phone, ...(email ? { email } : {}) },
      shippingAddress,
      paymentMethod: 'cod',
    });
}

function staffOrder(ctx, { phone = PHONE } = {}) {
  return request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', key())
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: { fullName: 'Risk Test Buyer', phone },
      shippingAddress: ADDRESS,
      paymentMethod: 'cod',
    });
}

async function setRules(ctx, fraudRules) {
  const res = await request(app)
    .patch(`/api/v1/workspaces/${ctx.workspace.id}`)
    .set(bearer(ctx.auth.accessToken))
    .send({ settings: { fraud_rules: fraudRules } });
  if (res.status !== 200) throw new Error(`fraud rules: ${res.status} ${JSON.stringify(res.body)}`);
}

function block(admin, body) {
  return request(app)
    .post('/api/v1/admin/risk/blocklist')
    .set(admin.H)
    .send({ reason: 'Chargeback ring', ...body });
}

const auditRows = (action) => db.AuditLog.findAll({ where: { action }, order: [['createdAt', 'ASC']] });

/** The refusal a buyer sees: the generic one, naming no rule and no list. */
function expectRefused(res) {
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('ORDER_REJECTED');
  expect(res.body.error.message).toBe(REJECTION_MESSAGE);
  expect(JSON.stringify(res.body)).not.toMatch(/blacklist|blocklist|platform|fraud|flag/i);
}

describe('platform blocklist — admin CRUD', () => {
  it('refuses a non-admin on every route', async () => {
    const plain = await setupPlain();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await request(app).get('/api/v1/admin/risk/blocklist').set(plain.H)).status).toBe(403);
    expect((await block(plain, { type: 'phone', value: PHONE })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/risk/blocklist/${id}`).set(plain.H).send({ reason: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/admin/risk/blocklist/${id}`).set(plain.H)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/risk/signals').set(plain.H)).status).toBe(403);
    expect(await db.PlatformBlocklistEntry.count()).toBe(0);
  });

  it('blocks a phone in its normalized form and audits it as a platform-level write', async () => {
    const admin = await setupAdmin();
    const res = await block(admin, { type: 'phone', value: '010 5555 0001' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.entry).toMatchObject({
      type: 'phone',
      value: '201055550001',
      label: '010 5555 0001',
      reason: 'Chargeback ring',
      expiresAt: null,
      status: 'active',
      createdById: admin.userId,
    });

    const [audit] = await auditRows('platform_blocklist.create');
    expect(audit).toMatchObject({
      workspaceId: null,
      actorUserId: admin.userId,
      entityType: 'PlatformBlocklistEntry',
      entityId: res.body.entry.id,
    });
    expect(audit.afterState).toMatchObject({ type: 'phone', value: '201055550001', reason: 'Chargeback ring' });
  });

  it('re-blocking the same identifier updates it (200) instead of duplicating it', async () => {
    const admin = await setupAdmin();
    const first = await block(admin, { type: 'phone', value: PHONE });
    const again = await block(admin, { type: 'phone', value: '+20 105 555 0001', reason: 'Still at it' });

    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.entry.id).toBe(first.body.entry.id);
    expect(again.body.entry.reason).toBe('Still at it');
    expect(await db.PlatformBlocklistEntry.count()).toBe(1);

    const [update] = await auditRows('platform_blocklist.update');
    expect(update.beforeState.reason).toBe('Chargeback ring');
    expect(update.afterState.reason).toBe('Still at it');
  });

  it('lowercases an email and fingerprints an address', async () => {
    const admin = await setupAdmin();
    const email = await block(admin, { type: 'email', value: '  Fraud@Example.COM ' });
    expect(email.status).toBe(201);
    expect(email.body.entry.value).toBe('fraud@example.com');

    const address = await block(admin, { type: 'address', address: ADDRESS });
    expect(address.status).toBe(201);
    expect(address.body.entry.value).toMatch(/^[0-9a-f]{32}$/);
    expect(address.body.entry.label).toBe('12 Tahrir St., Cairo, EG');

    // The same doorstep typed differently is the same entry.
    const variant = await block(admin, { type: 'address', address: { country: 'eg', city: ' CAIRO', addressLine: '12, tahrir st' } });
    expect(variant.status).toBe(200);
    expect(variant.body.entry.id).toBe(address.body.entry.id);
  });

  it('rejects an identifier that cannot be one, and an expiry in the past', async () => {
    const admin = await setupAdmin();
    expect((await block(admin, { type: 'phone', value: '123' })).status).toBe(422);
    expect((await block(admin, { type: 'email', value: 'not-an-email' })).status).toBe(422);
    expect((await block(admin, { type: 'address', address: { country: 'EG', city: 'Cairo', addressLine: '---' } })).status).toBe(422);
    expect((await block(admin, { type: 'phone', address: ADDRESS })).status).toBe(422);
    expect((await block(admin, { type: 'phone', value: PHONE, reason: '' })).status).toBe(422);
    expect((await block(admin, { type: 'phone', value: PHONE, expiresAt: '2020-01-01T00:00:00.000Z' })).status).toBe(422);
    expect(await db.PlatformBlocklistEntry.count()).toBe(0);
  });

  it('updates the reason and expiry, deletes, and audits both', async () => {
    const admin = await setupAdmin();
    const { body } = await block(admin, { type: 'phone', value: PHONE });
    const id = body.entry.id;
    const until = new Date(Date.now() + 7 * 86400000).toISOString();

    const patched = await request(app)
      .patch(`/api/v1/admin/risk/blocklist/${id}`)
      .set(admin.H)
      .send({ reason: 'Reviewed', expiresAt: until });
    expect(patched.status).toBe(200);
    expect(patched.body.entry).toMatchObject({ reason: 'Reviewed', status: 'active' });
    expect(new Date(patched.body.entry.expiresAt).toISOString()).toBe(until);

    const del = await request(app).delete(`/api/v1/admin/risk/blocklist/${id}`).set(admin.H);
    expect(del.status).toBe(200);
    expect(await db.PlatformBlocklistEntry.count()).toBe(0);
    expect((await request(app).delete(`/api/v1/admin/risk/blocklist/${id}`).set(admin.H)).status).toBe(404);

    const [deleted] = await auditRows('platform_blocklist.delete');
    expect(deleted).toMatchObject({ workspaceId: null, actorUserId: admin.userId, entityId: id });
    expect(deleted.beforeState.reason).toBe('Reviewed');
  });

  it('lists newest first, filtered by type, status and a search that understands phone formats', async () => {
    const admin = await setupAdmin();
    await block(admin, { type: 'phone', value: PHONE });
    await block(admin, { type: 'email', value: 'a@example.com' });
    const lapsed = await block(admin, { type: 'phone', value: '01055550002' });
    await db.PlatformBlocklistEntry.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { id: lapsed.body.entry.id } }
    );

    const all = await request(app).get('/api/v1/admin/risk/blocklist').set(admin.H);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.entries[0].id).toBe(lapsed.body.entry.id);
    expect(all.body.entries[0].status).toBe('expired');

    const phones = await request(app).get('/api/v1/admin/risk/blocklist?type=phone&status=active').set(admin.H);
    expect(phones.body.entries.map((e) => e.value)).toEqual(['201055550001']);

    const expired = await request(app).get('/api/v1/admin/risk/blocklist?status=expired').set(admin.H);
    expect(expired.body.entries.map((e) => e.id)).toEqual([lapsed.body.entry.id]);

    const search = await request(app).get(`/api/v1/admin/risk/blocklist?q=${encodeURIComponent('+201055550001')}`).set(admin.H);
    expect(search.body.entries.map((e) => e.value)).toEqual(['201055550001']);

    const paged = await request(app).get('/api/v1/admin/risk/blocklist?limit=1&offset=1').set(admin.H);
    expect(paged.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(paged.body.entries).toHaveLength(1);
  });

  it('labels its entries in the audit log', async () => {
    const admin = await setupAdmin();
    await block(admin, { type: 'email', value: 'a@example.com' });
    const res = await request(app).get('/api/v1/admin/audit-log?entityType=PlatformBlocklistEntry').set(admin.H);
    expect(res.body.auditLog[0].entityLabel).toBe('email: a@example.com');
  });
});

describe('platform blocklist — refuses order creation in every store', () => {
  it('refuses a storefront order in a store with no fraud rules, and audits it as a blocked customer', async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    const { body } = await block(admin, { type: 'phone', value: PHONE });

    expectRefused(await storefrontOrder(ctx));

    expect(await db.Order.count()).toBe(0);
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
    const [refusal] = await auditRows('order.blocked');
    expect(refusal).toMatchObject({ workspaceId: ctx.workspace.id, actorUserId: null, entityType: 'Customer' });
    expect(refusal.afterState).toEqual({ flags: ['blacklisted_customer'] });
    expect(refusal.metadata).toEqual({ platformBlocklist: { entryId: body.entry.id, type: 'phone' } });
  });

  it("refuses even when the store's own rules are explicitly off", async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    await setRules(ctx, { action: 'flag', block_blacklisted: false });
    await block(admin, { type: 'phone', value: PHONE });

    expectRefused(await storefrontOrder(ctx));
    expect(await db.Order.count()).toBe(0);
  });

  it('refuses a returning customer without touching their customer record', async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    expect((await storefrontOrder(ctx)).status).toBe(201);
    const customer = await db.Customer.findOne({ where: { workspaceId: ctx.workspace.id } });

    await block(admin, { type: 'phone', value: PHONE });
    expectRefused(await storefrontOrder(ctx));

    await customer.reload();
    expect(customer.isBlacklisted).toBe(false);
    expect(customer.blacklistReason).toBeNull();
    expect(await db.Order.count()).toBe(1);
    const [refusal] = await auditRows('order.blocked');
    expect(refusal.entityId).toBe(customer.id);
  });

  it('refuses in every store, not just one', async () => {
    const admin = await setupAdmin();
    const a = await setupWorkspaceWithProduct({ stock: 5 });
    const b = await setupWorkspaceWithProduct({ stock: 5 });
    await block(admin, { type: 'phone', value: PHONE });

    expectRefused(await storefrontOrder(a));
    expectRefused(await storefrontOrder(b));
    // A different phone in the same stores is untouched.
    const other = await storefrontOrder(a, { phone: '01055550009' });
    expect(other.status).toBe(201);
    expect((await storedOrder(other)).riskFlags).toEqual([]);
    expect((await auditRows('order.blocked')).map((r) => r.workspaceId).sort()).toEqual(
      [a.workspace.id, b.workspace.id].sort()
    );
  });

  it('matches on the contact email and on the shipping address, however it is typed', async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 10 });
    const email = await block(admin, { type: 'email', value: 'ring@example.com' });
    const address = await block(admin, { type: 'address', address: { country: 'EG', city: 'Giza', addressLine: '5 شارع الهرم' } });

    expectRefused(await storefrontOrder(ctx, { phone: '01055550011', email: 'Ring@Example.com' }));
    expectRefused(
      await storefrontOrder(ctx, {
        phone: '01055550012',
        shippingAddress: { country: 'EG', city: 'giza', addressLine: '٥ شارع  الهرم،' },
      })
    );
    const metadata = (await auditRows('order.blocked')).map((r) => r.metadata.platformBlocklist);
    expect(metadata).toEqual([
      { entryId: email.body.entry.id, type: 'email' },
      { entryId: address.body.entry.id, type: 'address' },
    ]);

    const clean = await storefrontOrder(ctx, {
      phone: '01055550013',
      email: 'someone@example.com',
      shippingAddress: { country: 'EG', city: 'Giza', addressLine: '6 شارع الهرم' },
    });
    expect(clean.status).toBe(201);
    expect((await storedOrder(clean)).riskFlags).toEqual([]);
  });

  it("refuses an order a staff member creates from the dashboard, and names them in the audit row", async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    await block(admin, { type: 'phone', value: PHONE });

    const res = await staffOrder(ctx);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_REJECTED');
    expect(await db.Order.count()).toBe(0);
    const [refusal] = await auditRows('order.blocked');
    expect(refusal).toMatchObject({ workspaceId: ctx.workspace.id, actorUserId: ctx.auth.userId });
    expect(refusal.afterState).toEqual({ flags: ['blacklisted_customer'] });
  });

  it('refuses an online (card) checkout before any payment is started', async () => {
    const saved = { ...env.payments };
    env.payments.onlineEnabled = true;
    env.payments.credentialsKey = fakePaymob.newKey();
    const paymob = fakePaymob.install();
    try {
      const admin = await setupAdmin();
      const ctx = await setupWorkspaceWithProduct({ stock: 5 });
      const connected = await request(app)
        .put(`/api/v1/workspaces/${ctx.workspace.id}/payments/gateways/paymob`)
        .set(bearer(ctx.auth.accessToken))
        .send({ credentials: fakePaymob.credentials('live'), settings: { cardIntegrationId: 111, walletIntegrationId: 222 } });
      expect(connected.status).toBe(200);
      await block(admin, { type: 'phone', value: PHONE });

      const res = await request(app)
        .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
        .set('Idempotency-Key', key())
        .send({
          item: { variantId: ctx.variant.id, quantity: 1 },
          contact: { fullName: 'Risk Test Buyer', phone: PHONE },
          shippingAddress: ADDRESS,
          paymentMethod: 'card',
          returnUrl: 'http://localhost:3001/store/x/pay/return',
        });
      expectRefused(res);
      expect(await db.Order.count()).toBe(0);
      expect(await db.Payment.count()).toBe(0);
      expect(paymob.lastIntention()).toBeFalsy();
    } finally {
      Object.assign(env.payments, saved);
      jest.restoreAllMocks();
    }
  });

  it('respects the expiry: a future expiry still refuses, a lapsed one no longer does', async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    const { body } = await block(admin, {
      type: 'phone',
      value: PHONE,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expectRefused(await storefrontOrder(ctx));

    await db.PlatformBlocklistEntry.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: body.entry.id } });
    const afterExpiry = await storefrontOrder(ctx);
    expect(afterExpiry.status).toBe(201);
    expect((await storedOrder(afterExpiry)).riskFlags).toEqual([]);

    // Extending it (the admin edits the expiry) blocks again.
    const extended = await request(app)
      .patch(`/api/v1/admin/risk/blocklist/${body.entry.id}`)
      .set(admin.H)
      .send({ expiresAt: null });
    expect(extended.body.entry.status).toBe('active');
    expectRefused(await storefrontOrder(ctx));
  });

  it('stops refusing once the entry is deleted', async () => {
    const admin = await setupAdmin();
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    const { body } = await block(admin, { type: 'phone', value: PHONE });
    expectRefused(await storefrontOrder(ctx));

    await request(app).delete(`/api/v1/admin/risk/blocklist/${body.entry.id}`).set(admin.H).expect(200);
    expect((await storefrontOrder(ctx)).status).toBe(201);
  });

  it("leaves the store's own blocklist working as before", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    // Blacklisted in this store only, with the store's rule off: flagged, not refused.
    const first = await storefrontOrder(ctx);
    await db.Customer.update({ isBlacklisted: true, blacklistReason: 'x' }, { where: { id: (await storedOrder(first)).customerId } });
    const flagged = await storefrontOrder(ctx);
    expect(flagged.status).toBe(201);
    expect((await storedOrder(flagged)).riskFlags).toEqual(['blacklisted_customer']);

    await setRules(ctx, { block_blacklisted: true });
    expectRefused(await storefrontOrder(ctx));
    const [refusal] = await auditRows('order.blocked');
    expect(refusal.metadata).toBeNull();
  });

  it('leaves orders exactly as before while the blocklist is empty', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    await setRules(ctx, { block_blacklisted: true });
    const res = await storefrontOrder(ctx);
    expect(res.status).toBe(201);
    expect((await storedOrder(res)).riskFlags).toEqual([]);
  });
});

// An online order placed before its entry existed: checked again, on what the
// order stores, when it would become a sale (onlinePaymentService).
describe('platform blocklist — checked again when an unpaid online order would become a sale', () => {
  const savedPayments = { ...env.payments };
  let paymob;

  beforeEach(() => {
    env.payments.onlineEnabled = true;
    env.payments.credentialsKey = fakePaymob.newKey();
    paymob = fakePaymob.install();
  });

  afterEach(() => {
    Object.assign(env.payments, savedPayments);
    jest.restoreAllMocks();
  });

  async function onlineStore({ stock = 5 } = {}) {
    const ctx = await setupWorkspaceWithProduct({ stock });
    const res = await request(app)
      .put(`/api/v1/workspaces/${ctx.workspace.id}/payments/gateways/paymob`)
      .set(bearer(ctx.auth.accessToken))
      .send({ credentials: fakePaymob.credentials('live'), settings: { cardIntegrationId: 111, walletIntegrationId: 222 } });
    if (res.status !== 200) throw new Error(`connect: ${res.status} ${JSON.stringify(res.body)}`);
    return { ...ctx, hookToken: res.body.connection.webhookUrl.split('/').pop() };
  }

  /** A card order placed while nothing blocks it: unpaid, its attempt open at Paymob. */
  async function placeCardOrder(ctx, { email = 'buyer@example.com' } = {}) {
    const res = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('Idempotency-Key', key())
      .send({
        item: { variantId: ctx.variant.id, quantity: 1 },
        contact: { fullName: 'Risk Test Buyer', phone: PHONE, email },
        shippingAddress: ADDRESS,
        paymentMethod: 'card',
        returnUrl: 'http://localhost:3001/store/x/pay/return',
      });
    if (res.status !== 201) throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`);
    return { order: res.body.order, token: res.body.paymentToken, paymobOrderId: paymob.lastIntention().orderId };
  }

  const switchToCod = (ctx, placed) =>
    request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/orders/${placed.order.id}/payment/switch-to-cod`)
      .set('X-Payment-Token', placed.token)
      .send({});

  const shopperStatus = (ctx, placed) =>
    request(app).get(`/api/v1/store/${ctx.workspace.id}/orders/${placed.order.id}/payment`).set('X-Payment-Token', placed.token);

  const paidAtPaymob = (placed) => fakePaymob.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) });

  function webhook(ctx, obj) {
    const { body, query } = fakePaymob.webhook(obj);
    return request(app).post(`/api/v1/webhooks/payments/paymob/${ctx.hookToken}`).query(query).send(body);
  }

  it('refuses a switch to cash on delivery once the phone is blocked, and leaves the order as it was', async () => {
    const admin = await setupAdmin();
    const ctx = await onlineStore();
    const placed = await placeCardOrder(ctx);
    const { body } = await block(admin, { type: 'phone', value: PHONE });

    expectRefused(await switchToCod(ctx, placed));

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.paymentMethod).toBe('card');
    expect(order.paymentExpiresAt).not.toBeNull();
    expect(order.cancelledAt).toBeNull();
    expect(order.completedAt).toBeNull();
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db.Payment.findOne({ where: { orderId: order.id } })).status).toBe('initialized');
    expect(await auditRows('order.switched_to_cod')).toHaveLength(0);

    const [refusal] = await auditRows('order.blocked');
    expect(refusal).toMatchObject({
      workspaceId: ctx.workspace.id,
      actorUserId: null,
      entityType: 'Order',
      entityId: order.id,
    });
    expect(refusal.afterState).toEqual({ flags: ['blacklisted_customer'], on: 'switch_to_cod' });
    expect(refusal.metadata).toEqual({ platformBlocklist: { entryId: body.entry.id, type: 'phone' } });
  });

  it('lets the switch to cash on delivery through when nothing matches', async () => {
    const admin = await setupAdmin();
    const ctx = await onlineStore();
    const placed = await placeCardOrder(ctx);
    // Somebody else, on every identifier type.
    await block(admin, { type: 'phone', value: '01055550099' });
    await block(admin, { type: 'email', value: 'someone-else@example.com' });
    await block(admin, { type: 'address', address: { country: 'EG', city: 'Giza', addressLine: '99 Other St.' } });

    const res = await switchToCod(ctx, placed);
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('cod');
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.paymentMethod).toBe('cod');
    expect(order.completedAt).toBeTruthy();
    expect(await auditRows('order.blocked')).toHaveLength(0);
  });

  it('records a payment that lands after the block, but cancels the order instead of completing it', async () => {
    const admin = await setupAdmin();
    const ctx = await onlineStore({ stock: 5 });
    const placed = await placeCardOrder(ctx);
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(1);
    // The same doorstep, typed differently.
    const { body } = await block(admin, { type: 'address', address: { country: 'eg', city: ' CAIRO', addressLine: '12, tahrir st' } });

    const obj = paidAtPaymob(placed);
    const res = await webhook(ctx, obj);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('paid_blocked');

    const order = await db.Order.findByPk(placed.order.id);
    // Not a sale: cancelled, never completed, its stock given back.
    expect(order.cancelledAt).toBeTruthy();
    expect(order.cancellationReason).toBe('customer_blocked');
    expect(order.completedAt).toBeNull();
    expect(order.paymentExpiresAt).toBeNull();
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
    expect(await db.Invoice.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db.Customer.findByPk(order.customerId)).totalOrders).toBe(0);
    // The money is on record, flagged for the merchant to give back.
    expect((await db.Payment.findOne({ where: { orderId: order.id } })).status).toBe('captured');
    expect(order.financialState).toBe('paid');
    expect(Number(order.amountPaid)).toBe(Number(order.totalAmount));
    expect(order.riskFlags).toEqual(expect.arrayContaining(['blacklisted_customer', 'paid_after_cancel']));

    const [refusal] = await auditRows('order.blocked');
    expect(refusal).toMatchObject({
      workspaceId: ctx.workspace.id,
      actorUserId: null,
      entityType: 'Order',
      entityId: order.id,
    });
    expect(refusal.afterState).toEqual({ flags: ['blacklisted_customer'], on: 'payment' });
    expect(refusal.metadata).toEqual({ platformBlocklist: { entryId: body.entry.id, type: 'address' } });

    // Redelivered: stored once, refused once.
    expect((await webhook(ctx, obj)).body.outcome).toBe('duplicate');
    expect(await auditRows('order.blocked')).toHaveLength(1);

    // The shopper sees a cancelled order, not a confirmation, and nothing about why.
    const status = await shopperStatus(ctx, placed);
    expect(status.body.payment.status).toBe('cancelled');
    expect(JSON.stringify(status.body)).not.toMatch(/blacklist|blocklist|blocked|platform|fraud|flag/i);
    expect((await switchToCod(ctx, placed)).status).toBe(409);

    // It cannot ship; the merchant refunds it through the gateway as usual.
    const ship = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(ctx.auth.accessToken))
      .send({ carrierCode: 'manual' });
    expect(ship.status).toBe(409);
    expect(ship.body.error.code).toBe('ORDER_CANCELLED');
    const refund = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/refunds`)
      .set(bearer(ctx.auth.accessToken))
      .send({ amount: Number(order.totalAmount), reason: 'Blocked customer' });
    expect(refund.status).toBe(201);
    expect(refund.body.refund.status).toBe('processed');
    expect((await db.Order.findByPk(order.id)).financialState).toBe('refunded');
  });

  it('does not reopen an expired order whose payment lands after the block', async () => {
    const admin = await setupAdmin();
    const ctx = await onlineStore({ stock: 3 });
    const placed = await placeCardOrder(ctx, { email: 'late@example.com' });
    await db.Order.update({ paymentExpiresAt: new Date(Date.now() - 60000) }, { where: { id: placed.order.id } });
    await shopperStatus(ctx, placed);
    expect((await db.Order.findByPk(placed.order.id)).cancellationReason).toBe('payment_expired');
    const { body } = await block(admin, { type: 'email', value: 'LATE@example.com' });

    expect((await webhook(ctx, paidAtPaymob(placed))).body.outcome).toBe('paid_blocked');

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.cancelledAt).toBeTruthy();
    expect(order.cancellationReason).toBe('customer_blocked');
    expect(order.completedAt).toBeNull();
    expect(order.financialState).toBe('paid');
    expect(order.riskFlags).toEqual(expect.arrayContaining(['blacklisted_customer', 'paid_after_expiry']));
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
    const [refusal] = await auditRows('order.blocked');
    expect(refusal.metadata).toEqual({ platformBlocklist: { entryId: body.entry.id, type: 'email' } });
  });

  it('completes a paid order as usual when nothing matches', async () => {
    const admin = await setupAdmin();
    const ctx = await onlineStore();
    const placed = await placeCardOrder(ctx);
    await block(admin, { type: 'phone', value: '01055550099' });
    await block(admin, { type: 'email', value: 'someone-else@example.com' });

    const res = await webhook(ctx, paidAtPaymob(placed));
    expect(res.body.outcome).toBe('paid');
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.cancelledAt).toBeNull();
    expect(order.completedAt).toBeTruthy();
    expect(order.financialState).toBe('paid');
    expect(order.riskFlags).toEqual([]);
    expect((await shopperStatus(ctx, placed)).body.payment.status).toBe('paid');
    expect(await auditRows('order.blocked')).toHaveLength(0);
  });

  it('ignores an expired entry on both paths, and blocks again once it is extended', async () => {
    const admin = await setupAdmin();
    const ctx = await onlineStore();
    const toSwitch = await placeCardOrder(ctx);
    const toPay = await placeCardOrder(ctx);
    const later = await placeCardOrder(ctx);
    const { body } = await block(admin, { type: 'phone', value: PHONE });
    await db.PlatformBlocklistEntry.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: body.entry.id } });

    expect((await switchToCod(ctx, toSwitch)).status).toBe(200);
    expect((await webhook(ctx, paidAtPaymob(toPay))).body.outcome).toBe('paid');
    expect((await db.Order.findByPk(toPay.order.id)).completedAt).toBeTruthy();
    expect(await auditRows('order.blocked')).toHaveLength(0);

    await db.PlatformBlocklistEntry.update({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }, { where: { id: body.entry.id } });
    expectRefused(await switchToCod(ctx, later));
  });
});

describe('platform risk — signals', () => {
  /** One workspace per call, each with a stocked product. */
  const stores = (n) => Promise.all(Array.from({ length: n }, () => setupWorkspaceWithProduct({ stock: 20 })));

  it('surfaces a phone ordering in several stores, naming the stores', async () => {
    const admin = await setupAdmin();
    const [a, b, c] = await stores(3);
    for (const ctx of [a, b, c]) expect((await storefrontOrder(ctx)).status).toBe(201);
    // Two stores only: below the default threshold of three.
    for (const ctx of [a, b]) await storefrontOrder(ctx, { phone: '01055550002' });

    const res = await request(app).get('/api/v1/admin/risk/signals').set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.thresholds).toMatchObject({ type: 'phone', windowDays: 90, minWorkspaces: 3, minRefused: 3 });
    const [signal] = res.body.signals;
    expect(signal).toMatchObject({
      type: 'phone',
      value: '201055550001',
      label: PHONE,
      workspaceCount: 3,
      orderCount: 3,
      refusedCount: 0,
      reasons: ['multi_store'],
      blocked: false,
      blocklistEntryId: null,
      block: { type: 'phone', value: '201055550001' },
    });
    expect(signal.workspaces.map((w) => w.id).sort()).toEqual([a, b, c].map((x) => x.workspace.id).sort());
    expect(signal.workspaces.every((w) => typeof w.name === 'string')).toBe(true);

    const lowered = await request(app).get('/api/v1/admin/risk/signals?minWorkspaces=2').set(admin.H);
    expect(lowered.body.total).toBe(2);
  });

  it('surfaces many cancelled or returned orders, but not a loyal buyer with a few', async () => {
    const admin = await setupAdmin();
    const [ctx] = await stores(1);
    const refused = [];
    for (let i = 0; i < 3; i += 1) refused.push((await storefrontOrder(ctx)).body.order.id);
    await db.Order.update({ cancelledAt: new Date(), cancellationReason: 'test' }, { where: { id: refused.slice(0, 2) } });
    await db.Order.update({ fulfillmentState: 'returned' }, { where: { id: refused[2] } });

    // 3 refused out of 9 orders: a third, under the 50% bar.
    const loyal = '01055550003';
    const loyalOrders = [];
    for (let i = 0; i < 9; i += 1) loyalOrders.push((await storefrontOrder(ctx, { phone: loyal })).body.order.id);
    await db.Order.update({ cancelledAt: new Date() }, { where: { id: loyalOrders.slice(0, 3) } });

    const res = await request(app).get('/api/v1/admin/risk/signals').set(admin.H);
    expect(res.body.signals.map((s) => s.value)).toEqual(['201055550001']);
    expect(res.body.signals[0]).toMatchObject({
      orderCount: 3,
      cancelledCount: 2,
      returnedCount: 1,
      refusedCount: 3,
      refusalRate: 1,
      reasons: ['high_refusal'],
    });
  });

  it('marks a signal blocked once its own block payload is posted to the blocklist', async () => {
    const admin = await setupAdmin();
    const all = await stores(3);
    const typed = ['12 Tahrir St.', '12 tahrir st', '12, TAHRIR ST'];
    for (const [i, ctx] of all.entries()) {
      await storefrontOrder(ctx, { phone: `0105555002${i}`, shippingAddress: { ...ADDRESS, addressLine: typed[i] } });
    }

    const res = await request(app).get('/api/v1/admin/risk/signals?type=address').set(admin.H);
    expect(res.body.total).toBe(1);
    const [signal] = res.body.signals;
    expect(signal.workspaceCount).toBe(3);
    expect(signal.block.type).toBe('address');

    const blocked = await block(admin, { ...signal.block, source: 'signal' });
    expect(blocked.status).toBe(201);
    expect(blocked.body.entry.value).toBe(signal.value);
    expect((await auditRows('platform_blocklist.create'))[0].metadata).toEqual({ source: 'signal' });

    const after = await request(app).get('/api/v1/admin/risk/signals?type=address').set(admin.H);
    expect(after.body.signals[0]).toMatchObject({ blocked: true, blocklistEntryId: blocked.body.entry.id });
  });

  it('groups emails case-insensitively and pages with a stable total', async () => {
    const admin = await setupAdmin();
    const all = await stores(3);
    for (const [i, ctx] of all.entries()) {
      await storefrontOrder(ctx, { phone: `0105555003${i}`, email: i === 0 ? 'Dup@Example.com' : 'dup@example.com' });
      await storefrontOrder(ctx, { phone: `0105555004${i}`, email: 'other@example.com' });
    }

    const page1 = await request(app).get('/api/v1/admin/risk/signals?type=email&limit=1').set(admin.H);
    const page2 = await request(app).get('/api/v1/admin/risk/signals?type=email&limit=1&offset=1').set(admin.H);
    const beyond = await request(app).get('/api/v1/admin/risk/signals?type=email&limit=1&offset=5').set(admin.H);
    expect(page1.body.total).toBe(2);
    expect(page2.body.total).toBe(2);
    expect(beyond.body).toMatchObject({ total: 2, signals: [] });
    expect([page1.body.signals[0].value, page2.body.signals[0].value].sort()).toEqual(['dup@example.com', 'other@example.com']);
  });

  it('ignores orders outside the window', async () => {
    const admin = await setupAdmin();
    const all = await stores(3);
    for (const ctx of all) await storefrontOrder(ctx);
    await db.sequelize.query("UPDATE orders SET created_at = NOW() - interval '40 days'");

    expect((await request(app).get('/api/v1/admin/risk/signals').set(admin.H)).body.total).toBe(1);
    expect((await request(app).get('/api/v1/admin/risk/signals?windowDays=30').set(admin.H)).body.total).toBe(0);
  });

  it('rejects thresholds out of range', async () => {
    const admin = await setupAdmin();
    expect((await request(app).get('/api/v1/admin/risk/signals?minWorkspaces=1').set(admin.H)).status).toBe(422);
    expect((await request(app).get('/api/v1/admin/risk/signals?windowDays=400').set(admin.H)).status).toBe(422);
    expect((await request(app).get('/api/v1/admin/risk/signals?type=ip').set(admin.H)).status).toBe(422);
  });
});
