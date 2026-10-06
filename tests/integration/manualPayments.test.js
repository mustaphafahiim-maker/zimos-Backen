'use strict';

// A store's manual payment methods (InstaPay, a mobile wallet) and the proof a
// shopper sends for an order paid by one (modules/manualPayments).

const fs = require('fs');
const path = require('path');
const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const { pngWithAlpha } = require('../helpers/images');
const db = require('../../src/db/models');
const { PRIVATE_ROOT } = require('../../src/modules/media/storage/localStorage');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `mp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const contact = { fullName: 'Transfer Buyer', phone: '01055550001' };
const address = { country: 'EG', city: 'Cairo', addressLine: '1 Transfer St' };

afterAll(() => {
  fs.rmSync(path.join(PRIVATE_ROOT, 'customer-uploads'), { recursive: true, force: true });
});

const methodsUrl = (ws) => `/api/v1/workspaces/${ws}/manual-payments/methods`;

function addMethod(ctx, body) {
  return request(app).post(methodsUrl(ctx.workspace.id)).set(bearer(ctx.auth.accessToken)).send(body);
}

async function instapay(ctx, extra = {}) {
  const res = await addMethod(ctx, { kind: 'instapay', label: 'InstaPay', accountNumber: 'store@instapay', ...extra });
  if (res.status !== 201) throw new Error(`instapay: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.method;
}

function checkout(ctx, body) {
  return request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', key())
    .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact, shippingAddress: address, ...body });
}

async function manualOrder(ctx, method) {
  const res = await checkout(ctx, { paymentMethod: 'bank_transfer', manualPaymentMethodId: method.id });
  if (res.status !== 201) throw new Error(`manual checkout: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function sendProof(ws, orderId, token, { payerNumber = '01011112222', file, filename = 'proof.png' } = {}) {
  const req = request(app).post(`/api/v1/store/${ws}/orders/${orderId}/manual-payment/proof`);
  if (token) req.set('X-Payment-Token', token);
  if (payerNumber !== null) req.field('payerNumber', payerNumber);
  return req.attach('file', file, { filename, contentType: 'image/png' });
}

const review = (ctx, orderId, action, body = {}, token = ctx.auth.accessToken) =>
  request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/manual-payments/orders/${orderId}/${action}`)
    .set(bearer(token))
    .send(body);

const confirm = (ctx, orderId) =>
  request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${orderId}/confirmation`).set(bearer(ctx.auth.accessToken)).send({});

describe('manual payment methods', () => {
  it('needs a number for each kind; the link is optional and https only', async () => {
    const ctx = await setupWorkspaceWithProduct();

    const noLink = await addMethod(ctx, { kind: 'instapay', label: 'InstaPay', accountNumber: 'store@instapay' });
    expect(noLink.status).toBe(201);
    expect(noLink.body.method.paymentLink).toBeNull();

    const emptyLink = await addMethod(ctx, { kind: 'wallet', label: 'Vodafone Cash', accountNumber: '010 1234 5678', paymentLink: '' });
    expect(emptyLink.status).toBe(201);
    expect(emptyLink.body.method.paymentLink).toBeNull();

    const nullLink = await addMethod(ctx, { kind: 'wallet', label: 'Wallet', accountNumber: '01012345678', paymentLink: null });
    expect(nullLink.status).toBe(201);
    expect(nullLink.body.method.paymentLink).toBeNull();

    const https = await addMethod(ctx, { kind: 'instapay', label: 'IPA', accountNumber: 'shop@instapay', paymentLink: 'https://ipn.eg/S/shop/instapay/abc' });
    expect(https.status).toBe(201);
    expect(https.body.method.paymentLink).toBe('https://ipn.eg/S/shop/instapay/abc');

    expect((await addMethod(ctx, { kind: 'instapay', label: 'X', accountNumber: 'a@b', paymentLink: 'http://ipn.eg/x' })).status).toBe(422);
    expect((await addMethod(ctx, { kind: 'instapay', label: 'X', accountNumber: 'a@b', paymentLink: 'javascript:alert(1)' })).status).toBe(422);
    expect((await addMethod(ctx, { kind: 'instapay', label: 'X' })).status).toBe(422);
    expect((await addMethod(ctx, { kind: 'wallet', label: 'X' })).status).toBe(422);
    expect((await addMethod(ctx, { kind: 'wallet', label: 'X', accountNumber: 'not-a-number' })).status).toBe(422);
    expect((await addMethod(ctx, { kind: 'card', label: 'X', accountNumber: '01012345678' })).status).toBe(422);

    // Clearing a link later stores null; a kind change must still fit its number.
    const id = https.body.method.id;
    const cleared = await request(app).patch(`${methodsUrl(ctx.workspace.id)}/${id}`).set(bearer(ctx.auth.accessToken)).send({ paymentLink: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.method.paymentLink).toBeNull();
    const badKind = await request(app).patch(`${methodsUrl(ctx.workspace.id)}/${id}`).set(bearer(ctx.auth.accessToken)).send({ kind: 'wallet' });
    expect(badKind.status).toBe(422);

    const audit = await db.AuditLog.count({ where: { workspaceId: ctx.workspace.id, action: 'store_payment_method.create' } });
    expect(audit).toBe(4);
  });

  it('lists, reorders, disables and deletes; workspace.manage only; other stores refused', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const a = await instapay(ctx);
    const b = await instapay(ctx, { kind: 'wallet', label: 'Wallet', accountNumber: '01099998888' });

    const reordered = await request(app).put(`${methodsUrl(ctx.workspace.id)}/order`).set(bearer(ctx.auth.accessToken)).send({ ids: [b.id, a.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.methods.map((m) => m.id)).toEqual([b.id, a.id]);

    const off = await request(app).patch(`${methodsUrl(ctx.workspace.id)}/${b.id}`).set(bearer(ctx.auth.accessToken)).send({ active: false });
    expect(off.body.method.active).toBe(false);
    const store = await request(app).get(`/api/v1/store/${ctx.workspace.id}/manual-payment-methods`);
    expect(store.body.methods.map((m) => m.id)).toEqual([a.id]);

    // A confirmation agent does not hold workspace.manage.
    const agent = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'confirmation_agent');
    expect((await request(app).get(methodsUrl(ctx.workspace.id)).set(bearer(agent.accessToken))).status).toBe(403);

    // Another store's owner: not a member here, and their own store has no such method.
    const other = await setupWorkspaceWithProduct();
    expect((await request(app).get(methodsUrl(ctx.workspace.id)).set(bearer(other.auth.accessToken))).status).toBe(404);
    const cross = await request(app).patch(`${methodsUrl(other.workspace.id)}/${a.id}`).set(bearer(other.auth.accessToken)).send({ label: 'Mine' });
    expect(cross.status).toBe(404);
    const crossOrder = await request(app).put(`${methodsUrl(other.workspace.id)}/order`).set(bearer(other.auth.accessToken)).send({ ids: [a.id] });
    expect(crossOrder.status).toBe(404);
    expect((await request(app).delete(`${methodsUrl(other.workspace.id)}/${a.id}`).set(bearer(other.auth.accessToken))).status).toBe(404);

    expect((await request(app).delete(`${methodsUrl(ctx.workspace.id)}/${a.id}`).set(bearer(ctx.auth.accessToken))).status).toBe(204);
    expect(await db.StorePaymentMethod.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
  });
});

describe('an order paid by a manual method', () => {
  it('is placed unpaid with a token, in the queue, and refuses a method that is not this store\'s or inactive', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 25000 });
    const method = await instapay(ctx);
    const placed = await manualOrder(ctx, method);

    expect(placed.order.paymentMethod).toBe('bank_transfer');
    expect(placed.order.financialState).toBe('pending');
    expect(placed.paymentToken).toEqual(expect.any(String));
    expect(placed.manualPayment).toMatchObject({ status: 'awaiting_proof', canSubmit: true, method: { kind: 'instapay', accountNumber: 'store@instapay', paymentLink: null } });
    expect(await db.ConfirmationTask.count({ where: { orderId: placed.order.id } })).toBe(1);

    const other = await setupWorkspaceWithProduct();
    const foreign = await instapay(other);
    expect((await checkout(ctx, { paymentMethod: 'bank_transfer', manualPaymentMethodId: foreign.id })).status).toBe(422);
    expect((await checkout(ctx, { paymentMethod: 'bank_transfer' })).status).toBe(422);
    expect((await checkout(ctx, { paymentMethod: 'cod', manualPaymentMethodId: method.id })).status).toBe(422);
    await db.StorePaymentMethod.update({ active: false }, { where: { id: method.id } });
    expect((await checkout(ctx, { paymentMethod: 'bank_transfer', manualPaymentMethodId: method.id })).status).toBe(422);

    // Never retried online or switched by the gateway endpoints.
    const switched = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/orders/${placed.order.id}/payment/switch-to-cod`)
      .set('X-Payment-Token', placed.paymentToken)
      .send({});
    expect(switched.status).toBe(409);
  });

  it('checks the proof: token, store, payer number, file type and size', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const method = await instapay(ctx);
    const placed = await manualOrder(ctx, method);
    const ws = ctx.workspace.id;
    const id = placed.order.id;
    const png = await pngWithAlpha();

    expect((await sendProof(ws, id, 'wrong-token', { file: png })).status).toBe(404);
    expect((await sendProof(ws, id, null, { file: png })).status).toBe(404);
    const other = await setupWorkspaceWithProduct();
    expect((await sendProof(other.workspace.id, id, placed.paymentToken, { file: png })).status).toBe(404);

    expect((await sendProof(ws, id, placed.paymentToken, { file: png, payerNumber: 'abc' })).status).toBe(422);
    expect((await sendProof(ws, id, placed.paymentToken, { file: png, payerNumber: '1'.repeat(40) })).status).toBe(422);
    expect((await sendProof(ws, id, placed.paymentToken, { file: png, payerNumber: null })).status).toBe(422);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await sendProof(ws, id, placed.paymentToken, { file: svg, filename: 'x.svg' })).status).toBe(415);
    const tooBig = Buffer.alloc(16 * 1024 * 1024, 1);
    expect((await sendProof(ws, id, placed.paymentToken, { file: tooBig })).status).toBe(413);

    const ok = await sendProof(ws, id, placed.paymentToken, { file: png, payerNumber: '010 1111 2222' });
    expect(ok.status).toBe(201);
    expect(ok.body.manualPayment).toMatchObject({ status: 'submitted', canSubmit: false });
    const record = await db.OrderManualPayment.findOne({ where: { orderId: id } });
    expect(record.payerNumber).toBe('01011112222');
    expect(record.submittedAt).toBeTruthy();
    const upload = await db.CustomerUpload.findByPk(record.proofUploadId);
    expect(upload).toMatchObject({ workspaceId: ws, status: 'attached', expiresAt: null });

    // Under review: not replaced.
    expect((await sendProof(ws, id, placed.paymentToken, { file: png })).status).toBe(409);

    // An InstaPay handle is a valid payer too.
    const second = await manualOrder(ctx, method);
    expect((await sendProof(ws, second.order.id, second.paymentToken, { file: png, payerNumber: 'buyer.name@instapay' })).status).toBe(201);
  });

  it('is not confirmable until approved; reject, resend, approve, then confirm', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 30000 });
    const method = await instapay(ctx);
    const placed = await manualOrder(ctx, method);
    const ws = ctx.workspace.id;
    const id = placed.order.id;
    const png = await pngWithAlpha();

    // Nothing sent yet: neither confirmable nor reviewable.
    const early = await confirm(ctx, id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('MANUAL_PAYMENT_NOT_APPROVED');
    expect((await review(ctx, id, 'approve')).status).toBe(409);

    await sendProof(ws, id, placed.paymentToken, { file: png });

    // The queue shows the payer's number, the screenshot and the review flag.
    const queue = await request(app).get(`/api/v1/workspaces/${ws}/confirmation-tasks`).set(bearer(ctx.auth.accessToken));
    const task = queue.body.tasks.find((t) => t.orderId === id);
    expect(task.order.manualPayment).toMatchObject({ status: 'submitted', awaitingReview: true, payerNumber: '01011112222' });
    expect(task.order.manualPayment.proofUrl).toMatch(/\/customer-uploads\//);
    expect((await confirm(ctx, id)).status).toBe(409);

    // An agent without orders.manage cannot review.
    const agent = await addMemberWithRole(ctx.auth.accessToken, ws, 'confirmation_agent');
    expect((await review(ctx, id, 'approve', {}, agent.accessToken)).status).toBe(403);
    // Another store cannot reach it.
    const other = await setupWorkspaceWithProduct();
    const foreign = await request(app)
      .post(`/api/v1/workspaces/${other.workspace.id}/manual-payments/orders/${id}/approve`)
      .set(bearer(other.auth.accessToken))
      .send({});
    expect(foreign.status).toBe(404);

    expect((await review(ctx, id, 'reject', {})).status).toBe(422);
    const rejected = await review(ctx, id, 'reject', { reason: 'Amount does not match' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.manualPayment).toMatchObject({ status: 'rejected', rejectionReason: 'Amount does not match' });
    const seen = await request(app).get(`/api/v1/store/${ws}/orders/${id}/manual-payment`).set('X-Payment-Token', placed.paymentToken);
    expect(seen.body.manualPayment).toMatchObject({ status: 'rejected', rejectionReason: 'Amount does not match', canSubmit: true });

    expect((await sendProof(ws, id, placed.paymentToken, { file: png, payerNumber: '01033334444' })).status).toBe(201);
    const approved = await review(ctx, id, 'approve');
    expect(approved.status).toBe(200);
    expect(approved.body.manualPayment.status).toBe('approved');

    const order = await db.Order.findByPk(id);
    expect(order.financialState).toBe('paid');
    expect(Number(order.amountPaid)).toBe(Number(order.totalAmount));
    expect((await review(ctx, id, 'approve')).status).toBe(409);

    const actions = (await db.AuditLog.findAll({ where: { workspaceId: ws, entityId: id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['order.manual_payment_submitted', 'order.manual_payment_rejected', 'order.manual_payment_approved']));

    const detail = await request(app).get(`/api/v1/workspaces/${ws}/orders/${id}`).set(bearer(ctx.auth.accessToken));
    expect(detail.body.order.manualPayment).toMatchObject({ status: 'approved', payerNumber: '01033334444' });

    expect((await confirm(ctx, id)).status).toBe(200);
  });

  it('leaves cash on delivery as it was', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await instapay(ctx);
    const res = await checkout(ctx, { paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    expect(res.body.paymentToken).toBeUndefined();
    expect(res.body.manualPayment).toBeUndefined();
    expect(res.body.order.paymentMethod).toBe('cod');
    expect(await db.OrderManualPayment.count({ where: { orderId: res.body.order.id } })).toBe(0);
    expect((await confirm(ctx, res.body.order.id)).status).toBe(200);
  });
});
