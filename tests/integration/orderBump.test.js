'use strict';

// The merchant-chosen order bump (checkout/orderBump.js): the store's bump in
// workspaces.settings.order_bump, a funnel checkout step's bump_offer_id, and
// the checkout that turns a ticked bump into one more line of the same order —
// priced from the configured offer only, shipped, taxed and reserved with the
// rest of it.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const nextPhone = () => `0101${String(1000000 + (seq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '12 Abbas El Akkad Street' };

async function setup({ price = 15000, stock = 20, bumpPrice = 8000, bumpStock = 10 } = {}) {
  const ctx = await setupWorkspaceWithProduct({ price, stock });
  const token = ctx.auth.accessToken;
  const ws = ctx.workspace.id;
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token));
  // The add-on: its own product, sold as a 2-piece offer.
  const bump = await createProductWithVariant(token, ws, { price: 5000, stock: bumpStock });
  const offerRes = await api('post', `/catalog/products/${bump.product.id}/offers`).send({
    name: 'Two socks',
    priceAmount: bumpPrice,
    lines: [{ variantId: bump.variant.id, quantity: 2 }],
  });
  if (offerRes.status !== 201) throw new Error(`offer: ${offerRes.status} ${JSON.stringify(offerRes.body)}`);
  return { ...ctx, token, ws, api, bump, offer: offerRes.body.offer };
}

const setBump = (ctx, orderBump) => ctx.api('patch', '').send({ settings: { order_bump: orderBump } });

async function enableBump(ctx, extra = {}) {
  const res = await setBump(ctx, { enabled: true, offer_id: ctx.offer.id, title: 'Add socks', description: 'Two pairs', ...extra });
  if (res.status !== 200) throw new Error(`enable bump: ${res.status} ${JSON.stringify(res.body)}`);
}

const checkout = (ctx, body) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', `bump-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Bump Buyer', phone: nextPhone() },
      shippingAddress: ADDRESS,
      paymentMethod: 'cod',
      ...body,
    });

const reserved = async (variantId) => (await db.ProductVariant.findByPk(variantId)).reservedStock;

describe('order bump — store settings', () => {
  it('shows the configured bump on the public store, priced from its offer', async () => {
    const ctx = await setup();
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.orderBump).toBeNull();

    await enableBump(ctx);
    const store = (await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store;
    expect(store.orderBump).toMatchObject({
      offerId: ctx.offer.id,
      variantId: ctx.bump.variant.id,
      productId: ctx.bump.product.id,
      title: 'Add socks',
      description: 'Two pairs',
      name: 'Two socks',
      priceAmount: 8000,
      // Two pieces at 5000 each, one by one.
      compareAtAmount: 10000,
      lines: [{ variantId: ctx.bump.variant.id, quantity: 2 }],
    });
    const stored = (await db.Workspace.findByPk(ctx.ws)).settings.order_bump;
    expect(stored).toEqual({ enabled: true, offer_id: ctx.offer.id, title: 'Add socks', description: 'Two pairs' });

    // Switched off: gone from the store, the choice kept for later.
    expect((await setBump(ctx, { enabled: false, offer_id: ctx.offer.id })).status).toBe(200);
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.orderBump).toBeNull();
  });

  it('refuses a bump offer that cannot be one', async () => {
    const ctx = await setup();
    const other = await setupWorkspaceWithProduct();
    const foreign = await request(app)
      .post(`/api/v1/workspaces/${other.workspace.id}/catalog/products/${other.product.id}/offers`)
      .set(bearer(other.auth.accessToken))
      .send({ name: 'Theirs', priceAmount: 100, lines: [{ variantId: other.variant.id, quantity: 1 }] });

    // Another store's offer, a missing one, and "on" with no offer.
    expect((await setBump(ctx, { enabled: true, offer_id: foreign.body.offer.id })).status).toBe(422);
    expect((await setBump(ctx, { enabled: true, offer_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
    expect((await setBump(ctx, { enabled: true, offer_id: null })).status).toBe(422);

    // An archived offer.
    await ctx.api('patch', `/catalog/offers/${ctx.offer.id}`).send({ status: 'archived' });
    expect((await setBump(ctx, { enabled: true, offer_id: ctx.offer.id })).status).toBe(422);
    await ctx.api('patch', `/catalog/offers/${ctx.offer.id}`).send({ status: 'active' });

    // A product that asks the shopper something cannot sit behind a tick box.
    await ctx.api('patch', `/catalog/products/${ctx.bump.product.id}`).send({
      customFields: [{ id: 'name', type: 'text', label: { en: 'Name' }, required: true }],
    });
    const withFields = await setBump(ctx, { enabled: true, offer_id: ctx.offer.id });
    expect(withFields.status).toBe(422);
    expect(withFields.body.error.details[0].code).toBe('BUMP_OFFER_CUSTOM_FIELDS');
  });

  it('lists the store offers for the picker, saying which cannot be a bump', async () => {
    const ctx = await setup();
    await ctx.api('patch', `/catalog/products/${ctx.bump.product.id}`).send({ name: 'Socks' });
    const res = await ctx.api('get', '/catalog/offers?q=sock');
    expect(res.status).toBe(200);
    expect(res.body.offers).toHaveLength(1);
    expect(res.body.offers[0]).toMatchObject({ id: ctx.offer.id, productName: 'Socks', bumpProblem: null });
    expect(Number(res.body.offers[0].priceAmount)).toBe(8000);
  });
});

describe('order bump — checkout', () => {
  it('adds the bump as a line of the same order, priced from the offer, stock reserved', async () => {
    const ctx = await setup();
    await enableBump(ctx);

    const res = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(res.status).toBe(201);
    const { order } = res.body;
    expect(order.items).toHaveLength(2);
    const bumpLine = order.items.find((i) => i.offerId === ctx.offer.id);
    expect(bumpLine).toMatchObject({ isOrderBump: true, quantity: 1, variantId: ctx.bump.variant.id });
    expect(Number(bumpLine.unitPriceAmount)).toBe(8000);
    expect(order.items.find((i) => i.offerId !== ctx.offer.id).isOrderBump).toBe(false);
    expect(Number(order.subtotalAmount)).toBe(15000 + 8000);
    expect(Number(order.totalAmount)).toBe(Number(order.subtotalAmount) + Number(order.shippingAmount) + Number(order.taxAmount));

    // The offer's two pieces are held, with the main product.
    expect(await reserved(ctx.bump.variant.id)).toBe(2);
    expect(await reserved(ctx.variant.id)).toBe(1);
    const stored = await db.OrderItem.findAll({ where: { orderId: order.id } });
    expect(stored.filter((i) => i.isOrderBump)).toHaveLength(1);
  });

  it('refuses a bump that is not the configured one, and places nothing', async () => {
    const ctx = await setup();
    // No bump configured at all.
    const none = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('ORDER_BUMP_INVALID');

    // Configured, but the request names another (real, active) offer of the store.
    await enableBump(ctx);
    const cheap = await ctx.api('post', `/catalog/products/${ctx.bump.product.id}/offers`).send({
      name: 'Almost free',
      priceAmount: 1,
      lines: [{ variantId: ctx.bump.variant.id, quantity: 5 }],
    });
    const forged = await checkout(ctx, { orderBump: { offerId: cheap.body.offer.id } });
    expect(forged.status).toBe(422);
    expect(forged.body.error.code).toBe('ORDER_BUMP_INVALID');

    // A price in the body is not part of the contract and changes nothing.
    const priced = await checkout(ctx, { orderBump: { offerId: ctx.offer.id, priceAmount: 1 } });
    expect(priced.status).toBe(201);
    expect(Number(priced.body.order.items.find((i) => i.isOrderBump).unitPriceAmount)).toBe(8000);

    expect(await db.Order.count({ where: { workspaceId: ctx.ws } })).toBe(1);
    expect(await reserved(ctx.variant.id)).toBe(1);
  });

  it('never lets a staff order or a cart line claim to be the bump', async () => {
    const ctx = await setup();
    const res = await ctx
      .api('post', '/orders')
      .set('Idempotency-Key', `staff-${Date.now()}`)
      .send({
        items: [{ variantId: ctx.bump.variant.id, offerId: ctx.offer.id, quantity: 1, isOrderBump: true }],
        contact: { fullName: 'Staff Order', phone: nextPhone() },
        paymentMethod: 'cod',
      });
    expect(res.status).toBe(201);
    expect(res.body.order.items[0].isOrderBump).toBe(false);
  });

  it('counts the bump toward the free-shipping threshold', async () => {
    const ctx = await setup({ price: 15000, bumpPrice: 6000 });
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000, free_shipping_threshold_amount: 20000 } });
    await enableBump(ctx);

    const without = await checkout(ctx, {});
    expect(Number(without.body.order.shippingAmount)).toBe(5000);

    const withBump = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(withBump.status).toBe(201);
    expect(Number(withBump.body.order.subtotalAmount)).toBe(21000);
    expect(Number(withBump.body.order.shippingAmount)).toBe(0);
    expect(Number(withBump.body.order.totalAmount)).toBe(21000 + Number(withBump.body.order.taxAmount));
  });

  it('moves the parcel to the next weight tier when the bump makes it heavier', async () => {
    const ctx = await setup();
    const put = await ctx.api('put', '/shipping/weight-tiers').send({ tiers: [{ upToGrams: 1000 }, { upToGrams: 3000 }] });
    const tiers = put.body.tiers;
    const zone = (await ctx.api('post', '/shipping/zones').send({ name: 'Egypt', countries: ['EG'] })).body.zone;
    await ctx
      .api('put', `/shipping/zones/${zone.id}/tier-prices`)
      .send({ prices: [{ tierId: tiers[0].id, amount: 3000 }, { tierId: tiers[1].id, amount: 5000 }] });
    const mode = await ctx
      .api('post', '/shipping/pricing-mode')
      .send({ mode: 'weight_tiers', defaultItemWeightGrams: 500, prefill: false });
    expect(mode.status).toBe(200);
    await ctx.api('patch', `/catalog/variants/${ctx.variant.id}`).send({ weightGrams: 800 });
    await ctx.api('patch', `/catalog/variants/${ctx.bump.variant.id}`).send({ weightGrams: 350 });
    await enableBump(ctx);

    const light = await checkout(ctx, {});
    expect(light.body.order.totalWeightGrams).toBe(800);
    expect(Number(light.body.order.shippingAmount)).toBe(3000);

    // 800 g + two pieces of 350 g = 1500 g: the 1–3 kg tier.
    const heavy = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(heavy.status).toBe(201);
    expect(heavy.body.order.totalWeightGrams).toBe(1500);
    expect(Number(heavy.body.order.shippingAmount)).toBe(5000);
  });

  it('refuses a sold-out bump with ORDER_BUMP_UNAVAILABLE and holds nothing', async () => {
    const ctx = await setup({ bumpStock: 1 });
    await enableBump(ctx);
    // The offer needs two pieces; one is left.
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.orderBump).toBeNull();

    const res = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_BUMP_UNAVAILABLE');
    expect(await reserved(ctx.variant.id)).toBe(0);
    expect(await reserved(ctx.bump.variant.id)).toBe(0);
    expect(await db.Order.count({ where: { workspaceId: ctx.ws } })).toBe(0);

    // The same order without the add-on goes through.
    expect((await checkout(ctx, {})).status).toBe(201);
  });

  it('refuses a bump whose offer was archived after it was set', async () => {
    const ctx = await setup();
    await enableBump(ctx);
    await ctx.api('patch', `/catalog/offers/${ctx.offer.id}`).send({ status: 'archived' });
    const res = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_BUMP_UNAVAILABLE');
  });
});

describe('order bump — funnel checkout step', () => {
  const tree = () => ({
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 'x' } }] }] }],
      },
    ],
  });

  async function funnelWithBump(ctx, bumpOfferId) {
    const base = `/funnels`;
    const funnel = (await ctx.api('post', base).send({ name: 'Bump Funnel' })).body.funnel;
    const step = await ctx.api('post', `${base}/${funnel.id}/steps`).send({
      key: 'checkout',
      stepType: 'checkout',
      name: 'Checkout',
      builderData: tree(),
      bumpOfferId,
    });
    await ctx.api('post', `${base}/${funnel.id}/steps`).send({ key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree() });
    await ctx.api('post', `${base}/${funnel.id}/edges`).send({ fromStepKey: 'checkout', toStepKey: 'thanks', condition: { type: 'always' } });
    const pub = await ctx.api('post', `${base}/${funnel.id}/publish`).send({});
    return { funnel, step: step.body.step, pub };
  }

  it('offers the step bump on the funnel checkout and accepts only it there', async () => {
    const ctx = await setup();
    const { funnel, step, pub } = await funnelWithBump(ctx, ctx.offer.id);
    expect(step.bumpOfferId).toBe(ctx.offer.id);
    expect(pub.status).toBe(201);

    const start = await request(app).post(`/api/v1/store/${ctx.ws}/funnels/${funnel.id}/sessions`).send({ visitorId: 'bump-v1' });
    expect(start.body.step.stepType).toBe('checkout');
    expect(start.body.bump).toMatchObject({ offerId: ctx.offer.id, priceAmount: 8000 });

    const ok = await checkout(ctx, { funnelId: funnel.id, orderBump: { offerId: ctx.offer.id } });
    expect(ok.status).toBe(201);
    expect(ok.body.order.items.filter((i) => i.isOrderBump)).toHaveLength(1);

    // The store's own bump is a different offer and is not accepted on the funnel.
    const other = await ctx.api('post', `/catalog/products/${ctx.product.id}/offers`).send({
      name: 'Store bump',
      priceAmount: 100,
      lines: [{ variantId: ctx.variant.id, quantity: 1 }],
    });
    await setBump(ctx, { enabled: true, offer_id: other.body.offer.id });
    const wrong = await checkout(ctx, { funnelId: funnel.id, orderBump: { offerId: other.body.offer.id } });
    expect(wrong.status).toBe(422);
    // …nor the funnel's bump on the store checkout.
    const wrongStore = await checkout(ctx, { orderBump: { offerId: ctx.offer.id } });
    expect(wrongStore.status).toBe(422);
  });

  it('keeps bumps on checkout steps and refuses unusable offers', async () => {
    const ctx = await setup();
    const funnel = (await ctx.api('post', '/funnels').send({ name: 'F' })).body.funnel;
    const landing = await ctx.api('post', `/funnels/${funnel.id}/steps`).send({
      key: 'landing',
      stepType: 'landing',
      name: 'L',
      builderData: tree(),
      bumpOfferId: ctx.offer.id,
    });
    expect(landing.status).toBe(422);

    await ctx.api('patch', `/catalog/offers/${ctx.offer.id}`).send({ status: 'archived' });
    const archived = await ctx.api('post', `/funnels/${funnel.id}/steps`).send({
      key: 'co',
      stepType: 'checkout',
      name: 'C',
      builderData: tree(),
      bumpOfferId: ctx.offer.id,
    });
    expect(archived.status).toBe(422);
  });

  it('refuses to publish a funnel whose bump offer was archived since', async () => {
    const ctx = await setup();
    const funnel = (await ctx.api('post', '/funnels').send({ name: 'F2' })).body.funnel;
    await ctx.api('post', `/funnels/${funnel.id}/steps`).send({
      key: 'co',
      stepType: 'checkout',
      name: 'C',
      builderData: tree(),
      bumpOfferId: ctx.offer.id,
    });
    await ctx.api('post', `/funnels/${funnel.id}/steps`).send({ key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree() });
    await ctx.api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'co', toStepKey: 'thanks', condition: { type: 'always' } });
    await ctx.api('patch', `/catalog/offers/${ctx.offer.id}`).send({ status: 'archived' });
    const pub = await ctx.api('post', `/funnels/${funnel.id}/publish`).send({});
    expect(pub.status).toBe(422);
    expect(JSON.stringify(pub.body)).toContain('bumpOfferId');
  });

  it('clears the bump when a checkout step becomes another type', async () => {
    const ctx = await setup();
    const funnel = (await ctx.api('post', '/funnels').send({ name: 'F3' })).body.funnel;
    const step = (
      await ctx.api('post', `/funnels/${funnel.id}/steps`).send({
        key: 'co',
        stepType: 'checkout',
        name: 'C',
        builderData: tree(),
        bumpOfferId: ctx.offer.id,
      })
    ).body.step;
    const changed = await ctx.api('patch', `/funnels/${funnel.id}/steps/${step.id}`).send({ stepType: 'sales' });
    expect(changed.status).toBe(200);
    expect(changed.body.step.bumpOfferId).toBeNull();
  });
});
