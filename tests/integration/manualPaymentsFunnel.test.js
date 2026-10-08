'use strict';

// InstaPay / wallet (the store's manual methods) on the product page's quick
// form (Buy Now) and a funnel's checkout: the same POST /checkout as the cart,
// totals from the server only, the same proof and review queue, and an upsell
// that never changes the amount the shopper transfers.

const fs = require('fs');
const path = require('path');
const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const { pngWithAlpha } = require('../helpers/images');
const db = require('../../src/db/models');
const { PRIVATE_ROOT } = require('../../src/modules/media/storage/localStorage');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `mpf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let seq = 0;
const nextPhone = () => `0103${String(3000000 + (seq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '1 Transfer St' };

afterAll(() => {
  fs.rmSync(path.join(PRIVATE_ROOT, 'customer-uploads'), { recursive: true, force: true });
});

const tree = () => ({
  version: 1,
  sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 't' } }] }] }] }],
});

/**
 * A burger at 100.00 with a required Size (Small +0 / Large +30.00), delivery
 * 30.00 by default, an InstaPay method, and a funnel: checkout (its bump: an
 * add-on offer at 40.00) → upsell (an offer at 70.00) → thanks.
 */
async function setup() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
  const token = ctx.auth.accessToken;
  const ws = ctx.workspace.id;
  const api = (method, p) => request(app)[method](`/api/v1/workspaces/${ws}${p}`).set(bearer(token));
  await api('patch', '/shipping/settings').send({ defaultRateAmount: 3000 });

  const productId = ctx.product ? ctx.product.id : ctx.variant.productId;
  const menu = await api('put', `/product-options/${productId}`).send({
    groups: [{ name: 'Size', required: true, minSelect: 1, maxSelect: 1, choices: [{ name: 'Small', priceDeltaAmount: 0 }, { name: 'Large', priceDeltaAmount: 3000 }] }],
  });
  if (menu.status !== 200) throw new Error(`menu: ${menu.status} ${JSON.stringify(menu.body)}`);
  const size = menu.body.groups[0];
  const large = { groupId: size.id, choiceIds: [size.choices[1].id] };

  const offerFor = async (price, name) => {
    const p = await createProductWithVariant(token, ws, { price: price + 2000, stock: 20 });
    const res = await api('post', `/catalog/products/${p.product.id}/offers`).send({ name, priceAmount: price, lines: [{ variantId: p.variant.id, quantity: 1 }] });
    if (res.status !== 201) throw new Error(`offer: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.offer;
  };
  const bumpOffer = await offerFor(4000, 'Fries');
  const upsellOffer = await offerFor(7000, 'Dessert');

  const funnel = (await api('post', '/funnels').send({ name: 'Burger Funnel' })).body.funnel;
  const step = (body) => api('post', `/funnels/${funnel.id}/steps`).send(body);
  await step({ key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree(), bumpOfferId: bumpOffer.id });
  await step({ key: 'upsell', stepType: 'upsell', name: 'Upsell', builderData: tree(), offerId: upsellOffer.id });
  await step({ key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree() });
  await api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'completed_checkout' } });
  await api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'upsell', toStepKey: 'thanks', condition: { type: 'always' } });
  const pub = await api('post', `/funnels/${funnel.id}/publish`).send({});
  if (pub.status !== 201) throw new Error(`publish: ${pub.status} ${JSON.stringify(pub.body)}`);

  const method = await api('post', '/manual-payments/methods').send({ kind: 'instapay', label: 'InstaPay', accountNumber: 'burger@instapay' });
  if (method.status !== 201) throw new Error(`method: ${method.status} ${JSON.stringify(method.body)}`);
  return { ...ctx, token, ws, api, large, bumpOffer, upsellOffer, funnel, method: method.body.method };
}

const checkout = (ctx, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId: ctx.variant.id, quantity: 1, options: [ctx.large] },
      contact: { fullName: 'Transfer Buyer', phone: nextPhone() },
      shippingAddress: ADDRESS,
      paymentMethod: 'bank_transfer',
      manualPaymentMethodId: ctx.method.id,
      ...body,
    });

const shopperPayment = (ctx, orderId, token) =>
  request(app).get(`/api/v1/store/${ctx.ws}/orders/${orderId}/manual-payment`).set('X-Payment-Token', token);

function sendProof(ctx, orderId, token, { file, filename = 'proof.png', payerNumber = '01011112222' } = {}) {
  const req = request(app).post(`/api/v1/store/${ctx.ws}/orders/${orderId}/manual-payment/proof`);
  if (token) req.set('X-Payment-Token', token);
  req.field('payerNumber', payerNumber);
  return req.attach('file', file, { filename, contentType: 'image/png' });
}

const review = (ctx, orderId, action, body = {}) =>
  request(app).post(`/api/v1/workspaces/${ctx.ws}/manual-payments/orders/${orderId}/${action}`).set(bearer(ctx.token)).send(body);
const confirm = (ctx, orderId) =>
  request(app).post(`/api/v1/workspaces/${ctx.ws}/orders/${orderId}/confirmation`).set(bearer(ctx.token)).send({});

describe('manual payments on Buy Now and funnels: totals from the server', () => {
  it('prices a funnel InstaPay order from the menu, the zone and the step bump, whatever amounts the client sends', async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ deliveryZonesEnabled: true });
    const zone = (await ctx.api('post', '/delivery-zones').send({ name: 'Nasr City', feeAmount: 2000 })).body.zone;

    const res = await checkout(ctx, {
      funnelId: ctx.funnel.id,
      deliveryZoneId: zone.id,
      orderBump: { offerId: ctx.bumpOffer.id, priceAmount: 1 },
      item: { variantId: ctx.variant.id, quantity: 1, options: [ctx.large], priceAmount: 1, unitPriceAmount: 1 },
      // Not the client's to say: stripped by the schema, recomputed by the server.
      totalAmount: 100,
      subtotalAmount: 100,
      shippingAmount: 0,
      amountPaid: 19000,
    });
    expect(res.status).toBe(201);
    // 100 + Large 30 + Fries 40 + Nasr City 20 = 190.00
    const order = await db.Order.findByPk(res.body.order.id);
    expect(order.paymentMethod).toBe('bank_transfer');
    expect(order.funnelId).toBe(ctx.funnel.id);
    expect(Number(order.shippingAmount)).toBe(2000);
    expect(Number(order.totalAmount)).toBe(19000);
    expect(Number(order.amountPaid)).toBe(0);
    expect(order.financialState).toBe('pending');
    expect(res.body.paymentToken).toEqual(expect.any(String));
    expect(res.body.manualPayment).toMatchObject({
      totalAmount: 19000,
      status: 'awaiting_proof',
      canSubmit: true,
      method: { kind: 'instapay', accountNumber: 'burger@instapay' },
    });
  });

  it('prices a Buy Now InstaPay order the same way (menu + default delivery)', async () => {
    const ctx = await setup();
    const res = await checkout(ctx, { totalAmount: 1 });
    expect(res.status).toBe(201);
    expect(Number(res.body.order.totalAmount)).toBe(16000);
    expect(res.body.manualPayment.totalAmount).toBe(16000);
    // The required group is still enforced on this path.
    const missing = await checkout(ctx, { item: { variantId: ctx.variant.id, quantity: 1 } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('OPTIONS_INVALID');
  });

  it("refuses another store's method, an inactive one and a transfer with no method", async () => {
    const ctx = await setup();
    const other = await setupWorkspaceWithProduct();
    const foreign = await request(app)
      .post(`/api/v1/workspaces/${other.workspace.id}/manual-payments/methods`)
      .set(bearer(other.auth.accessToken))
      .send({ kind: 'wallet', label: 'Wallet', accountNumber: '01099998888' });
    const viaFunnel = await checkout(ctx, { funnelId: ctx.funnel.id, manualPaymentMethodId: foreign.body.method.id });
    expect(viaFunnel.status).toBe(422);
    expect(viaFunnel.body.error.details[0].field).toBe('manualPaymentMethodId');

    expect((await checkout(ctx, { manualPaymentMethodId: undefined })).status).toBe(422);
    await ctx.api('patch', `/manual-payments/methods/${ctx.method.id}`).send({ active: false });
    const inactive = await checkout(ctx, { funnelId: ctx.funnel.id });
    expect(inactive.status).toBe(422);
    expect(await db.Order.count({ where: { workspaceId: ctx.ws } })).toBe(0);
  });

  it('keeps cash on delivery working on both forms, and a store without methods exactly as before', async () => {
    const ctx = await setup();
    const cod = { paymentMethod: 'cod', manualPaymentMethodId: undefined };
    const buyNow = await checkout(ctx, cod);
    const funnel = await checkout(ctx, { ...cod, funnelId: ctx.funnel.id });
    expect([buyNow.status, funnel.status]).toEqual([201, 201]);
    expect(buyNow.body.paymentToken).toBeUndefined();
    expect(await db.OrderManualPayment.count({ where: { workspaceId: ctx.ws } })).toBe(0);
    // A method id next to cash on delivery is refused, as on the cart checkout.
    expect((await checkout(ctx, { paymentMethod: 'cod' })).status).toBe(422);

    const plain = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    expect((await request(app).get(`/api/v1/store/${plain.workspace.id}/manual-payment-methods`)).body.methods).toEqual([]);
    const body = { item: { variantId: plain.variant.id, quantity: 1 }, contact: { fullName: 'Plain', phone: nextPhone() }, shippingAddress: ADDRESS };
    const send = (extra) => request(app).post(`/api/v1/store/${plain.workspace.id}/checkout`).set('Idempotency-Key', key()).send({ ...body, ...extra });
    expect((await send({ paymentMethod: 'bank_transfer', manualPaymentMethodId: ctx.method.id })).status).toBe(422);
    const placed = await send({ paymentMethod: 'cod' });
    expect(placed.status).toBe(201);
    expect(placed.body.manualPayment).toBeUndefined();
  });
});

describe('manual payments on funnels: proof and review', () => {
  it('takes the proof for a funnel order within the limits; reject, resend, approve, then confirm', async () => {
    const ctx = await setup();
    const placed = (await checkout(ctx, { funnelId: ctx.funnel.id })).body;
    const id = placed.order.id;
    const png = await pngWithAlpha();

    expect((await sendProof(ctx, id, 'not-the-token', { file: png })).status).toBe(404);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await sendProof(ctx, id, placed.paymentToken, { file: svg, filename: 'x.svg' })).status).toBe(415);
    expect((await sendProof(ctx, id, placed.paymentToken, { file: Buffer.alloc(16 * 1024 * 1024, 1) })).status).toBe(413);
    expect((await sendProof(ctx, id, placed.paymentToken, { file: png, payerNumber: 'x' })).status).toBe(422);

    const sent = await sendProof(ctx, id, placed.paymentToken, { file: png });
    expect(sent.status).toBe(201);
    expect(sent.body.manualPayment.status).toBe('submitted');
    expect((await confirm(ctx, id)).body.error.code).toBe('MANUAL_PAYMENT_NOT_APPROVED');

    const rejected = await review(ctx, id, 'reject', { reason: 'Amount not received' });
    expect(rejected.status).toBe(200);
    const after = await shopperPayment(ctx, id, placed.paymentToken);
    expect(after.body.manualPayment).toMatchObject({ status: 'rejected', canSubmit: true, rejectionReason: 'Amount not received' });
    expect((await db.Order.findByPk(id)).cancelledAt).toBeNull();

    expect((await sendProof(ctx, id, placed.paymentToken, { file: png })).status).toBe(201);
    expect((await review(ctx, id, 'approve')).status).toBe(200);
    const paid = await db.Order.findByPk(id);
    expect(paid.financialState).toBe('paid');
    expect(Number(paid.amountPaid)).toBe(Number(paid.totalAmount));
    expect((await confirm(ctx, id)).status).toBe(200);
  });

  it('turns an accepted upsell into its own cash order: the transfer amount and its proof stay as they were', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { funnel_upsell_merge: true } });
    const placed = (await checkout(ctx, { funnelId: ctx.funnel.id })).body;
    const id = placed.order.id;
    expect((await sendProof(ctx, id, placed.paymentToken, { file: await pngWithAlpha() })).status).toBe(201);

    const store = `/api/v1/store/${ctx.ws}/funnels/${ctx.funnel.id}`;
    const sid = (await request(app).post(`${store}/sessions`).send({ visitorId: 'mp-v1' })).body.session.id;
    const atUpsell = await request(app)
      .post(`${store}/sessions/${sid}/advance`)
      .send({ fromStepKey: 'checkout', outcome: { type: 'completed_checkout', orderId: id } });
    expect(atUpsell.body.step.key).toBe('upsell');
    // The offer card does not say it joins the order.
    expect((await request(app).get(`${store}/sessions/${sid}/step`)).body.offerJoinsOrder).toBe(false);

    const accepted = await request(app).post(`${store}/sessions/${sid}/advance`).send({ fromStepKey: 'upsell', outcome: { type: 'accepted_offer' } });
    expect(accepted.status).toBe(200);

    const main = await db.Order.findByPk(id);
    expect(Number(main.totalAmount)).toBe(16000);
    const followOns = await db.Order.findAll({ where: { linkedFromOrderId: id } });
    expect(followOns).toHaveLength(1);
    expect(followOns[0].paymentMethod).toBe('cod');
    expect(Number(followOns[0].shippingAmount)).toBe(0);
    expect(Number(followOns[0].totalAmount)).toBe(7000);
    expect(await db.OrderManualPayment.count({ where: { orderId: followOns[0].id } })).toBe(0);

    const payment = (await shopperPayment(ctx, id, placed.paymentToken)).body.manualPayment;
    expect(payment).toMatchObject({ totalAmount: 16000, status: 'submitted' });
    expect((await review(ctx, id, 'approve')).status).toBe(200);
    expect(Number((await db.Order.findByPk(id)).amountPaid)).toBe(16000);
  });
});
