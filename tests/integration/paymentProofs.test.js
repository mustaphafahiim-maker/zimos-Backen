'use strict';

// A merchant paying a subscription charge by a manual transfer (InstaPay, a
// mobile wallet) and proving it with a screenshot, and a platform admin
// checking it (billing/paymentProofService):
//
//   POST /workspaces/:id/billing/invoices/open
//   POST /workspaces/:id/billing/invoices/:invoiceId/payment-proofs   multipart
//   GET  /workspaces/:id/billing/payment-proofs
//   GET  /admin/payment-proofs, /admin/payment-proofs/:id
//   POST /admin/payment-proofs/:id/approve | /reject
//   GET  /payment-proofs/:id/image?expires=&signature=
//
// The amount is always the server's; a charge is settled only by exactly its
// amount, through settlePaid, once.

const sharp = require('sharp');
const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const proofsService = require('../../src/modules/billing/paymentProofService');

const MONTHLY = 29900; // EGP 299

beforeEach(async () => {
  await db.Plan.create({ key: 'eg-basic', name: 'Basic', monthlyPriceAmount: MONTHLY, yearlyPriceAmount: MONTHLY * 10, currency: 'EGP' });
  await db.Plan.create({ key: 'us-basic', name: 'Basic USD', monthlyPriceAmount: 2900, yearlyPriceAmount: 29000, currency: 'USD' });
  await db.PaymentMethod.bulkCreate([
    { kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' },
    { kind: 'manual', code: 'wallet', labelAr: 'محفظة إلكترونية', labelEn: 'Mobile wallet', sortOrder: 20, enabled: false },
  ]);
});

let shade = 0;
/** A small real PNG, different every call (so its SHA-256 is too). */
async function screenshot() {
  shade += 1;
  return sharp({ create: { width: 24, height: 24, channels: 3, background: { r: shade % 256, g: (shade * 7) % 256, b: 90 } } })
    .png()
    .toBuffer();
}

async function newMerchant({ planKey = 'eg-basic', name = 'Paying Store' } = {}) {
  const owner = await registerAndActivate({ fullName: 'Mona Adel' });
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const res = await request(app).post('/api/v1/workspaces').set(H).send({ name });
  if (res.status !== 201) throw new Error(`merchant: ${res.status} ${JSON.stringify(res.body)}`);
  const plan = await db.Plan.findOne({ where: { key: planKey } });
  const wid = res.body.workspace.id;
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: wid } });
  return { wid, H, owner };
}

const base = (m) => `/api/v1/workspaces/${m.wid}/billing`;
const openInvoice = (m) => request(app).post(`${base(m)}/invoices/open`).set(m.H).send({});

async function sendProof(m, invoiceId, { methodCode = 'instapay', senderPhone = '01012345678', file, fields = {} } = {}) {
  const req = request(app).post(`${base(m)}/invoices/${invoiceId}/payment-proofs`).set(m.H);
  if (methodCode !== null) req.field('methodCode', methodCode);
  if (senderPhone !== null) req.field('senderPhone', senderPhone);
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  const image = file === undefined ? { buffer: await screenshot(), name: 'shot.png', type: 'image/png' } : file;
  if (image) req.attach('file', image.buffer, { filename: image.name, contentType: image.type });
  return req;
}

async function merchantWithOpenInvoice(opts) {
  const m = await newMerchant(opts);
  const res = await openInvoice(m);
  if (res.status !== 201) throw new Error(`open: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...m, invoiceId: res.body.invoice.id };
}

describe('the charge to pay', () => {
  it('is written on the server, at the plan price, when a way to pay is offered', async () => {
    const m = await newMerchant();
    const res = await openInvoice(m);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, invoice: { status: 'pending', amountDue: MONTHLY, currency: 'EGP' } });

    const again = await openInvoice(m);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, invoice: { id: res.body.invoice.id } });
  });

  it('is not written when nothing is offered: contact support', async () => {
    await db.PaymentMethod.update({ enabled: false }, { where: {} });
    const m = await newMerchant();
    const res = await openInvoice(m);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_PAYMENT_METHOD');
    expect(await db.BillingInvoice.count()).toBe(0);
  });
});

describe('sending a proof', () => {
  it('stores it privately with the server’s amount, ignoring any amount sent', async () => {
    const m = await merchantWithOpenInvoice();
    const res = await sendProof(m, m.invoiceId, { fields: { amount: '1', requestedAmount: '1', receivedAmount: '1' } });
    expect(res.status).toBe(201);
    expect(res.body.proof).toMatchObject({
      invoiceId: m.invoiceId,
      method: { code: 'instapay', label: { en: 'InstaPay' } },
      senderPhone: '201012345678',
      amount: MONTHLY,
      currency: 'EGP',
      status: 'pending',
      reviewNote: null,
    });
    const row = await db.PaymentProof.findByPk(res.body.proof.id);
    expect(row.imageKey).toMatch(new RegExp(`^payment-proofs/${m.wid}/[0-9a-f-]{36}\\.(jpg|webp)$`));
    expect(row.imageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.receivingNumber).toBe('zimos@instapay');
    expect(Number(row.requestedAmount)).toBe(MONTHLY);

    const list = await request(app).get(`${base(m)}/payment-proofs`).set(m.H);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.proofs).toHaveLength(1);
  });

  it('refuses the same image twice, even from another store', async () => {
    const a = await merchantWithOpenInvoice();
    const b = await merchantWithOpenInvoice({ name: 'Other Store' });
    const file = { buffer: await screenshot(), name: 'shot.png', type: 'image/png' };
    expect((await sendProof(a, a.invoiceId, { file })).status).toBe(201);

    const again = await sendProof(b, b.invoiceId, { file });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROOF_IMAGE_DUPLICATE');
    expect(await db.PaymentProof.count()).toBe(1);
  });

  it('refuses a file that is not a JPEG, PNG or WebP by its bytes', async () => {
    const m = await merchantWithOpenInvoice();
    const gif = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
    const asGif = await sendProof(m, m.invoiceId, { file: { buffer: gif, name: 'shot.png', type: 'image/png' } });
    expect(asGif.status).toBe(415);
    expect(asGif.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const text = await sendProof(m, m.invoiceId, { file: { buffer: Buffer.from('not an image at all'), name: 'a.jpg', type: 'image/jpeg' } });
    expect(text.status).toBe(415);
    expect(await db.PaymentProof.count()).toBe(0);
  });

  it('requires the screenshot', async () => {
    const m = await merchantWithOpenInvoice();
    const res = await sendProof(m, m.invoiceId, { file: null });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_FILE');
  });

  it('requires a valid Egyptian mobile number for the sender', async () => {
    const m = await merchantWithOpenInvoice();
    const missing = await sendProof(m, m.invoiceId, { senderPhone: null });
    expect(missing.status).toBe(422);
    for (const senderPhone of ['0223456789', '12345678', '01312345678', 'abcdefgh']) {
      const res = await sendProof(m, m.invoiceId, { senderPhone });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_SENDER_PHONE');
    }
    expect(await db.PaymentProof.count()).toBe(0);
    expect((await sendProof(m, m.invoiceId, { senderPhone: '+20 115 123 4567' })).status).toBe(201);
  });

  it('accepts only an enabled manual method', async () => {
    const m = await merchantWithOpenInvoice();
    for (const methodCode of ['wallet', 'fawaterak', 'cash']) {
      const res = await sendProof(m, m.invoiceId, { methodCode });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PAYMENT_METHOD_NOT_AVAILABLE');
    }
  });

  it('keeps one proof waiting per charge', async () => {
    const m = await merchantWithOpenInvoice();
    expect((await sendProof(m, m.invoiceId)).status).toBe(201);
    const again = await sendProof(m, m.invoiceId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROOF_ALREADY_OPEN');
  });

  it(`keeps at most ${proofsService.MAX_OPEN_PER_WORKSPACE} proofs waiting per store`, async () => {
    const m = await merchantWithOpenInvoice();
    const sub = await db.Subscription.findOne({ where: { workspaceId: m.wid } });
    const method = await db.PaymentMethod.findOne({ where: { code: 'instapay' } });
    for (let i = 0; i < proofsService.MAX_OPEN_PER_WORKSPACE; i += 1) {
      const old = await db.BillingInvoice.create({
        workspaceId: m.wid,
        subscriptionId: sub.id,
        grossAmount: MONTHLY,
        discountAmount: 0,
        amount: MONTHLY,
        currency: 'EGP',
        status: 'failed',
        periodStart: new Date(),
        periodEnd: new Date(),
      });
      await db.PaymentProof.create({
        workspaceId: m.wid,
        purpose: 'invoice',
        billingInvoiceId: old.id,
        paymentMethodId: method.id,
        methodCode: 'instapay',
        receivingNumber: 'zimos@instapay',
        senderPhone: '201012345678',
        currency: 'EGP',
        requestedAmount: MONTHLY,
        grossAmount: MONTHLY,
        discountAmount: 0,
        imageKey: `payment-proofs/${m.wid}/x${i}.jpg`,
        imageMime: 'image/jpeg',
        imageBytes: 10,
        imageSha256: String(i).repeat(64),
      });
    }
    const res = await sendProof(m, m.invoiceId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOO_MANY_OPEN_PROOFS');
  });

  it('refuses a charge in another currency', async () => {
    const m = await newMerchant({ planKey: 'us-basic' });
    const sub = await db.Subscription.findOne({ where: { workspaceId: m.wid } });
    const invoice = await db.BillingInvoice.create({
      workspaceId: m.wid,
      subscriptionId: sub.id,
      grossAmount: 2900,
      discountAmount: 0,
      amount: 2900,
      currency: 'USD',
      status: 'pending',
      periodStart: new Date(),
      periodEnd: new Date(),
    });
    const res = await sendProof(m, invoice.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MANUAL_PAYMENT_CURRENCY_UNSUPPORTED');
  });
});

describe('another store', () => {
  it('cannot send a proof for, or read, a charge or proof that is not its own', async () => {
    const a = await merchantWithOpenInvoice();
    const b = await merchantWithOpenInvoice({ name: 'Other Store' });
    expect((await sendProof(a, a.invoiceId)).status).toBe(201);

    // B naming A's charge under its own store: no such charge.
    const crossed = await sendProof(b, a.invoiceId);
    expect(crossed.status).toBe(404);
    // B under A's store: not a member.
    const asA = await request(app).get(`${base(a)}/payment-proofs`).set(b.H);
    expect([403, 404]).toContain(asA.status);
    const bList = await request(app).get(`${base(b)}/payment-proofs`).set(b.H);
    expect(bList.body.proofs).toHaveLength(0);
    expect(await db.PaymentProof.count({ where: { workspaceId: b.wid } })).toBe(0);
  });
});

describe('the review', () => {
  async function sentProof() {
    const m = await merchantWithOpenInvoice();
    const res = await sendProof(m, m.invoiceId);
    return { ...m, proofId: res.body.proof.id };
  }
  const approve = (admin, id, receivedAmount) =>
    request(app).post(`/api/v1/admin/payment-proofs/${id}/approve`).set(admin.H).send({ receivedAmount });
  const reject = (admin, id, body) => request(app).post(`/api/v1/admin/payment-proofs/${id}/reject`).set(admin.H).send(body);

  it('lists what waits and shows one with its image behind a short signed link', async () => {
    const m = await sentProof();
    const admin = await makePlatformUser('admin');
    const queue = await request(app).get('/api/v1/admin/payment-proofs?status=pending').set(admin.H);
    expect(queue.status).toBe(200);
    expect(queue.body.proofs).toEqual([
      expect.objectContaining({ id: m.proofId, workspace: expect.objectContaining({ id: m.wid }), requestedAmount: MONTHLY, senderPhone: '201012345678' }),
    ]);

    const one = await request(app).get(`/api/v1/admin/payment-proofs/${m.proofId}`).set(admin.H);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ invoice: { id: m.invoiceId, status: 'pending' }, approvalBlockers: [] });
    const url = new URL(one.body.image.url);
    expect(new Date(one.body.image.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

    const img = await request(app).get(`${url.pathname}${url.search}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/^image\/(jpeg|webp)$/);
    const forged = await request(app).get(`${url.pathname}?expires=${url.searchParams.get('expires')}&signature=${'0'.repeat(64)}`);
    expect(forged.status).toBe(404);
    const expired = await request(app).get(`${url.pathname}?expires=1000&signature=${url.searchParams.get('signature')}`);
    expect(expired.status).toBe(404);
  });

  it('settles nothing with an amount other than the charge’s, and says to reject', async () => {
    const m = await sentProof();
    const admin = await makePlatformUser('admin');
    for (const amount of [MONTHLY - 100, MONTHLY + 100, 0]) {
      const res = await approve(admin, m.proofId, amount);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('RECEIVED_AMOUNT_MISMATCH');
    }
    expect((await db.BillingInvoice.findByPk(m.invoiceId)).status).toBe('pending');
    expect((await db.PaymentProof.findByPk(m.proofId)).status).toBe('pending');
  });

  it('settles the charge through settlePaid with exactly its amount, once', async () => {
    const m = await sentProof();
    const admin = await makePlatformUser('admin');
    const res = await approve(admin, m.proofId, MONTHLY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyApproved: false, proof: { status: 'approved', receivedAmount: MONTHLY } });

    const invoice = await db.BillingInvoice.findByPk(m.invoiceId);
    expect(invoice).toMatchObject({ status: 'paid', paymentSource: 'manual', externalReference: `proof:${m.proofId}` });
    expect(Number(invoice.amountPaid)).toBe(MONTHLY);
    expect(invoice.recordedByUserId).toBe(admin.userId);
    expect((await db.Subscription.findOne({ where: { workspaceId: m.wid } })).status).toBe('active');

    const again = await approve(admin, m.proofId, MONTHLY);
    expect(again.status).toBe(200);
    expect(again.body.alreadyApproved).toBe(true);
    expect(await db.AuditLog.count({ where: { action: 'payment_proof.approve' } })).toBe(1);

    const mine = await request(app).get(`${base(m)}/payment-proofs`).set(m.H);
    expect(mine.body.proofs[0]).toMatchObject({ status: 'approved', reviewNote: null });
  });

  it('two approvals at the same moment settle once', async () => {
    const m = await sentProof();
    const admin = await makePlatformUser('admin');
    const results = await Promise.all([approve(admin, m.proofId, MONTHLY), approve(admin, m.proofId, MONTHLY)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.alreadyApproved).sort()).toEqual([false, true]);
    expect(await db.AuditLog.count({ where: { action: 'payment_proof.approve' } })).toBe(1);
  });

  it('refuses to settle a charge paid some other way meanwhile', async () => {
    const m = await sentProof();
    const admin = await makePlatformUser('admin');
    const paid = await request(app).post(`/api/v1/admin/charges/${m.invoiceId}/record-payment`).set(admin.H).send({ amountReceived: MONTHLY });
    expect(paid.status).toBe(200);
    const one = await request(app).get(`/api/v1/admin/payment-proofs/${m.proofId}`).set(admin.H);
    expect(one.body.approvalBlockers).toContain('CHARGE_ALREADY_PAID');
    const res = await approve(admin, m.proofId, MONTHLY);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHARGE_ALREADY_PAID');
  });

  it('a rejection needs a note, which the merchant reads; a rejected proof can’t be approved', async () => {
    const m = await sentProof();
    const admin = await makePlatformUser('admin');
    expect((await reject(admin, m.proofId, {})).status).toBe(422);
    const res = await reject(admin, m.proofId, { note: 'Nothing arrived from this number.' });
    expect(res.status).toBe(200);
    expect(res.body.proof).toMatchObject({ status: 'rejected', reviewNote: 'Nothing arrived from this number.' });

    const mine = await request(app).get(`${base(m)}/payment-proofs`).set(m.H);
    expect(mine.body.proofs[0]).toMatchObject({ status: 'rejected', reviewNote: 'Nothing arrived from this number.' });
    const late = await approve(admin, m.proofId, MONTHLY);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PROOF_ALREADY_REVIEWED');
    expect((await db.BillingInvoice.findByPk(m.invoiceId)).status).toBe('pending');

    // The charge can be proved again with another screenshot.
    expect((await sendProof(m, m.invoiceId)).status).toBe(201);
  });

  it('is for payments.record only', async () => {
    const m = await sentProof();
    const agent = await makePlatformUser('agent');
    expect((await request(app).get('/api/v1/admin/payment-proofs').set(agent.H)).status).toBe(403);
    expect((await approve(agent, m.proofId, MONTHLY)).status).toBe(403);
    const merchantTries = await request(app).get('/api/v1/admin/payment-proofs').set(m.H);
    expect(merchantTries.status).toBe(403);
  });
});
