'use strict';

// Gift cards (modules/giftCards, STORE_FEATURES gift_cards): issue, check, pay part of a
// cash-on-delivery order, refund back to the card, a cancelled order's card balance returned,
// and cards sold as a product.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const giftCards = require('../../src/modules/giftCards/giftCardService');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const checkout = (workspaceId, variantId, phone, giftCardCode) =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `gc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId, quantity: 1 }, contact: { fullName: 'Card Holder', phone }, paymentMethod: 'cod', ...(giftCardCode ? { giftCardCode } : {}) });

async function storeWithCard(amount) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000 });
  const order = await db.Workspace.findByPk(ctx.workspace.id, { attributes: ['defaultCurrency'] });
  const issued = await giftCards.issue(ctx.workspace.id, { amount, currency: order.defaultCurrency || 'EGP', sendEmail: false });
  return { ...ctx, H: { Authorization: `Bearer ${ctx.auth.accessToken}` }, code: issued.code, cardId: issued.giftCard.id };
}

const balanceOf = async (id) => Number((await db.GiftCard.findByPk(id)).balanceAmount);

describe('gift cards', () => {
  it('off: no routes, and a code at checkout is ignored', async () => {
    const { workspace, variant, H, code, cardId } = await storeWithCard(5000);
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/gift-cards`).set(H);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await request(app).post(`/api/v1/store/${workspace.id}/gift-cards/check`).send({ code })).status).toBe(404);

    const placed = await checkout(workspace.id, variant.id, '01055550001', code);
    expect(placed.status).toBe(201);
    expect(placed.body.giftCard).toBeUndefined();
    expect(Number((await db.Order.findByPk(placed.body.order.id)).amountPaid)).toBe(0);
    expect(await balanceOf(cardId)).toBe(5000);
  });

  it('on: staff issue a card; it pays part of a COD order, and a refund named on it goes back to the card', async () => {
    env.storeFeatures.push('gift_cards');
    const { workspace, variant, H } = await storeWithCard(1);
    const currency = (await db.Workspace.findByPk(workspace.id)).defaultCurrency || 'EGP';

    const issued = await request(app).post(`/api/v1/workspaces/${workspace.id}/gift-cards`).set(H).send({ amount: 4000, currency, sendEmail: false });
    expect(issued.status).toBe(201);
    expect(issued.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const { code } = issued.body;
    const cardId = issued.body.giftCard.id;

    const check = await request(app).post(`/api/v1/store/${workspace.id}/gift-cards/check`).send({ code: code.toLowerCase() });
    expect(check.body.giftCard).toMatchObject({ balanceAmount: '4000', state: 'active' });
    expect((await request(app).post(`/api/v1/store/${workspace.id}/gift-cards/check`).send({ code: 'AAAA-BBBB-CCCC-DDDD' })).status).toBe(404);

    const placed = await checkout(workspace.id, variant.id, '01055550002', code);
    expect(placed.status).toBe(201);
    expect(placed.body.giftCard).toMatchObject({ applied: true, amount: '4000', balanceAmount: '0' });
    const order = await db.Order.findByPk(placed.body.order.id);
    expect(Number(order.amountPaid)).toBe(4000);
    expect(order.financialState).toBe('partially_paid');
    expect(await balanceOf(cardId)).toBe(0);

    // Spent: refused before any order is made.
    const spent = await checkout(workspace.id, variant.id, '01055550003', code);
    expect(spent.status).toBe(422);
    expect(spent.body.error.code).toBe('GIFT_CARD_UNUSABLE');

    const payment = await db.Payment.findOne({ where: { orderId: order.id, providerCode: 'gift_card' } });
    const refunds = `/api/v1/workspaces/${workspace.id}/orders/${order.id}/refunds`;
    const tooMuch = await request(app).post(refunds).set(H).send({ amount: 4001, reason: 'too much', paymentId: payment.id });
    expect(tooMuch.status).toBe(422);
    const back = await request(app).post(refunds).set(H).send({ amount: 1500, reason: 'one item returned', paymentId: payment.id });
    expect(back.status).toBe(201);
    expect(await balanceOf(cardId)).toBe(1500);
    const kinds = (await db.GiftCardTransaction.findAll({ where: { giftCardId: cardId }, order: [['createdAt', 'ASC']] })).map((t) => t.kind);
    expect(kinds).toEqual(['issue', 'redeem', 'refund']);
  });

  it('on: a refund that names no payment never takes it from the card', async () => {
    env.storeFeatures.push('gift_cards');
    const { workspace, variant, H, code, cardId } = await storeWithCard(3000);
    const placed = await checkout(workspace.id, variant.id, '01055550004', code);
    const refund = await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${placed.body.order.id}/refunds`).set(H).send({ amount: 1000, reason: 'goodwill' });
    expect(refund.status).toBe(201);
    expect(await balanceOf(cardId)).toBe(0);
  });

  it('on: a cancelled order gives the card back what it paid, once', async () => {
    env.storeFeatures.push('gift_cards');
    const { workspace, variant, H, code, cardId } = await storeWithCard(2500);
    const placed = await checkout(workspace.id, variant.id, '01055550005', code);
    expect(await balanceOf(cardId)).toBe(0);

    const cancelled = await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${placed.body.order.id}/cancel`).set(H).send({ reason: 'customer asked' });
    expect(cancelled.status).toBe(200);
    expect(await balanceOf(cardId)).toBe(2500);
    await giftCards.refundCancelledOrder({ workspaceId: workspace.id, payload: { orderId: placed.body.order.id } });
    expect(await balanceOf(cardId)).toBe(2500);
  });

  it('on: a gift-card product sold issues one card per unit when the order is delivered, once', async () => {
    env.storeFeatures.push('gift_cards');
    const { workspace, product, variant, H } = await storeWithCard(1);
    expect((await request(app).put(`/api/v1/workspaces/${workspace.id}/gift-cards/settings`).set(H).send({ productIds: [product.id], validityDays: 365 })).status).toBe(200);
    const placed = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', `gc-sell-${Date.now()}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .send({ item: { variantId: variant.id, quantity: 2 }, contact: { fullName: 'Buyer', phone: '01055550006' }, paymentMethod: 'cod' });
    expect(placed.status).toBe(201);
    const event = { type: 'order.delivered', workspaceId: workspace.id, payload: { orderId: placed.body.order.id } };
    await giftCards.issueForOrder(event);
    await giftCards.issueForOrder(event);
    const sold = await db.GiftCard.findAll({ where: { workspaceId: workspace.id, source: 'order' } });
    expect(sold).toHaveLength(2);
    expect(sold.every((c) => Number(c.initialAmount) === 10000 && c.expiresAt)).toBe(true);
  });
});
