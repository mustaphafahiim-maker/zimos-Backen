'use strict';

// Menu options (option groups and choices with a price each): the line total
// is computed on the server from the database only; required groups and
// min/max picks are enforced; unknown, inactive or another product's or
// store's choices are refused; the order keeps a snapshot that later menu
// edits never change. A product without groups sells exactly as before.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const orderDocuments = require('../../src/modules/orders/orderDocuments');
const { customDataLines } = require('../../src/modules/waybill/customData');

let phoneSeq = 0;
const nextPhone = () => `0106${String(9000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'القاهرة (Cairo)', city: 'مدينة نصر', addressLine: '5 شارع عباس العقاد' };
const key = () => `mo-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// A burger at 100.00 EGP: Size (required, one) Small +0 / Large +30.00; Extras (optional, up to 2) Cheese +10.00 / Olives +5.00 / Bacon +15.00.
async function setup() {
  const { auth, workspace, variant, product } = await setupWorkspaceWithProduct({ price: 10000, stock: 100 });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
  const productId = product ? product.id : variant.productId;
  const res = await api('put', `/product-options/${productId}`).send({
    groups: [
      { name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: [{ name: 'صغير', priceDeltaAmount: 0 }, { name: 'كبير', priceDeltaAmount: 3000 }] },
      {
        name: 'إضافات',
        required: false,
        minSelect: 0,
        maxSelect: 2,
        choices: [
          { name: 'جبنة', priceDeltaAmount: 1000 },
          { name: 'زيتون', priceDeltaAmount: 500 },
          { name: 'بيكون', priceDeltaAmount: 1500 },
        ],
      },
    ],
  });
  if (res.status !== 200) throw new Error(`menu failed ${res.status} ${JSON.stringify(res.body)}`);
  const [size, extras] = res.body.groups;
  const c = (g, i) => g.choices[i].id;
  return {
    ws: workspace.id,
    variant,
    productId,
    api,
    auth,
    size,
    extras,
    pick: {
      large: { groupId: size.id, choiceIds: [c(size, 1)] },
      small: { groupId: size.id, choiceIds: [c(size, 0)] },
      cheeseOlives: { groupId: extras.id, choiceIds: [c(extras, 0), c(extras, 1)] },
      threeExtras: { groupId: extras.id, choiceIds: [c(extras, 0), c(extras, 1), c(extras, 2)] },
    },
  };
}

const checkout = (ctx, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', key())
    .send({ contact: { fullName: 'Menu Buyer', phone: nextPhone() }, shippingAddress: ADDRESS, paymentMethod: 'cod', ...body });

const buyNow = (ctx, options, quantity = 1, extra = {}) =>
  checkout(ctx, { item: { variantId: ctx.variant.id, quantity, options }, ...extra });

describe('menu options: managing them', () => {
  it('saves groups in order with stable ids, audits, and refuses min > max or another product’s ids', async () => {
    const ctx = await setup();
    const listed = await ctx.api('get', `/product-options/${ctx.productId}`);
    expect(listed.body.groups.map((g) => g.name)).toEqual(['الحجم', 'إضافات']);

    const bad = await ctx.api('put', `/product-options/${ctx.productId}`).send({ groups: [{ name: 'x', minSelect: 3, maxSelect: 1, choices: [{ name: 'a' }] }] });
    expect(bad.status).toBe(422);
    const neg = await ctx.api('put', `/product-options/${ctx.productId}`).send({ groups: [{ name: 'x', choices: [{ name: 'a', priceDeltaAmount: -5 }] }] });
    expect(neg.status).toBe(422);

    const other = await setup();
    const foreign = await ctx.api('put', `/product-options/${ctx.productId}`).send({ groups: [{ id: other.size.id, name: 'x', choices: [{ name: 'a' }] }] });
    expect(foreign.status).toBe(422);
    expect((await other.api('get', `/product-options/${ctx.productId}`)).status).toBe(404);

    const audits = await db.AuditLog.count({ where: { workspaceId: ctx.ws, action: 'product.options_update' } });
    expect(audits).toBe(1);

    // The storefront shows active groups and choices only.
    await ctx.api('put', `/product-options/${ctx.productId}`).send({
      groups: [
        { id: ctx.size.id, name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: [{ id: ctx.size.choices[0].id, name: 'صغير' }, { id: ctx.size.choices[1].id, name: 'كبير', priceDeltaAmount: 3000, active: false }] },
      ],
    });
    const page = await request(app).get(`/api/v1/store/${ctx.ws}/products/${ctx.productId}`);
    const groups = (page.body.product || page.body).optionGroups;
    expect(groups).toEqual([{ id: ctx.size.id, name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: [{ id: ctx.size.choices[0].id, name: 'صغير', priceDeltaAmount: 0 }] }]);
  });
});

describe('menu options: pricing on the server only', () => {
  it('prices Buy Now from the menu: 100 + large 30 + cheese 10 + olives 5 = 145 a unit; client prices are ignored', async () => {
    const ctx = await setup();
    const res = await checkout(ctx, {
      item: { variantId: ctx.variant.id, quantity: 2, options: [ctx.pick.large, ctx.pick.cheeseOlives], unitPriceAmount: 1, priceDeltaAmount: 0 },
      subtotal: 1,
      totalAmount: 1,
    });
    expect(res.status).toBe(201);
    const item = await db.OrderItem.findOne({ where: { orderId: res.body.order.id } });
    expect(Number(item.unitPriceAmount)).toBe(14500);
    expect(Number(item.lineTotalAmount)).toBe(29000);
    const order = await db.Order.findByPk(res.body.order.id);
    expect(Number(order.subtotalAmount)).toBe(29000);
    expect(Number(order.totalAmount)).toBe(29000);
    expect(item.optionsSnapshot).toEqual([
      { groupId: ctx.size.id, groupName: 'الحجم', choices: [{ choiceId: ctx.size.choices[1].id, name: 'كبير', priceDeltaAmount: 3000 }] },
      {
        groupId: ctx.extras.id,
        groupName: 'إضافات',
        choices: [
          { choiceId: ctx.extras.choices[0].id, name: 'جبنة', priceDeltaAmount: 1000 },
          { choiceId: ctx.extras.choices[1].id, name: 'زيتون', priceDeltaAmount: 500 },
        ],
      },
    ]);
  });

  it('enforces required groups and min/max, and refuses unknown, inactive and foreign choices', async () => {
    const ctx = await setup();
    const code = async (options) => {
      const res = await buyNow(ctx, options);
      return [res.status, res.body.error && res.body.error.details && res.body.error.details[0] && res.body.error.details[0].code];
    };
    expect(await code(undefined)).toEqual([422, 'REQUIRED']);
    expect(await code([ctx.pick.cheeseOlives])).toEqual([422, 'REQUIRED']);
    expect(await code([ctx.pick.large, ctx.pick.threeExtras])).toEqual([422, 'TOO_MANY']);
    expect(await code([{ groupId: ctx.size.id, choiceIds: [ctx.size.choices[0].id, ctx.size.choices[1].id] }])).toEqual([422, 'TOO_MANY']);
    expect(await code([{ groupId: ctx.size.id, choiceIds: [ctx.extras.choices[0].id] }])).toEqual([422, 'UNKNOWN_CHOICE']);

    const other = await setup();
    expect(await code([other.pick.large])).toEqual([422, 'UNKNOWN_GROUP']);
    expect(await code([{ groupId: ctx.size.id, choiceIds: [other.size.choices[1].id] }])).toEqual([422, 'UNKNOWN_CHOICE']);

    // Switch "large" off: it can no longer be picked.
    await ctx.api('put', `/product-options/${ctx.productId}`).send({
      groups: [{ id: ctx.size.id, name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: [{ id: ctx.size.choices[0].id, name: 'صغير' }, { id: ctx.size.choices[1].id, name: 'كبير', priceDeltaAmount: 3000, active: false }] }],
    });
    expect(await code([ctx.pick.large])).toEqual([422, 'UNKNOWN_CHOICE']);
    expect((await buyNow(ctx, [ctx.pick.small])).status).toBe(201);
    expect(await db.Order.count({ where: { workspaceId: ctx.ws } })).toBe(1);
  });

  it('keeps the order snapshot and its total when the menu changes later', async () => {
    const ctx = await setup();
    const res = await buyNow(ctx, [ctx.pick.large]);
    await ctx.api('put', `/product-options/${ctx.productId}`).send({
      groups: [{ id: ctx.size.id, name: 'Size', required: true, minSelect: 1, maxSelect: 1, choices: [{ id: ctx.size.choices[1].id, name: 'XL', priceDeltaAmount: 9900 }] }],
    });
    const item = await db.OrderItem.findOne({ where: { orderId: res.body.order.id } });
    expect(item.optionsSnapshot[0]).toMatchObject({ groupName: 'الحجم', choices: [{ name: 'كبير', priceDeltaAmount: 3000 }] });
    expect(Number(item.unitPriceAmount)).toBe(13000);
    expect(Number((await db.Order.findByPk(res.body.order.id)).totalAmount)).toBe(13000);
  });

  it('leaves a product without groups exactly as before, and refuses options sent for it', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 7000, stock: 10 });
    const plain = { ws: workspace.id, variant };
    const ok = await checkout(plain, { item: { variantId: variant.id, quantity: 1 } });
    expect(ok.status).toBe(201);
    const item = await db.OrderItem.findOne({ where: { orderId: ok.body.order.id } });
    expect(Number(item.unitPriceAmount)).toBe(7000);
    expect(item.optionsSnapshot).toBeNull();
    const ctx = await setup();
    const sent = await checkout(plain, { item: { variantId: variant.id, quantity: 1, options: [ctx.pick.large] } });
    expect(sent.status).toBe(422);
    expect(sent.body.error.code).toBe('OPTIONS_INVALID');
  });
});

describe('menu options: cart, funnel and payment paths', () => {
  async function cartWith(ctx, lines) {
    const cart = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
    const token = cart.body.cart ? cart.body.cart.guestToken : cart.body.guestToken;
    let last;
    for (const line of lines) {
      last = await request(app).post(`/api/v1/store/${ctx.ws}/cart/items`).set('X-Cart-Token', token).send(line);
    }
    return { token, last };
  }

  it('keeps different picks as separate cart lines priced from the menu, and checks out the same totals', async () => {
    const ctx = await setup();
    const refused = await cartWith(ctx, [{ variantId: ctx.variant.id, quantity: 1 }]);
    expect(refused.last.status).toBe(422);
    expect(refused.last.body.error.code).toBe('OPTIONS_INVALID');

    const { token, last } = await cartWith(ctx, [
      { variantId: ctx.variant.id, quantity: 1, options: [ctx.pick.large], unitPriceAmount: 1 },
      { variantId: ctx.variant.id, quantity: 2, options: [ctx.pick.small, ctx.pick.cheeseOlives] },
      { variantId: ctx.variant.id, quantity: 1, options: [ctx.pick.large] },
    ]);
    expect(last.status).toBe(201);
    const cart = last.body.cart || last.body;
    expect(cart.items.map((i) => [i.quantity, i.currentUnitPrice])).toEqual([
      [2, 13000],
      [2, 11500],
    ]);
    expect(cart.subtotal).toBe(49000);

    const res = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', key())
      .send({ contact: { fullName: 'Cart', phone: nextPhone() }, shippingAddress: ADDRESS, paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    expect(Number((await db.Order.findByPk(res.body.order.id)).subtotalAmount)).toBe(49000);
  });

  it('prices a funnel checkout the same way and enforces its required group', async () => {
    const ctx = await setup();
    const tree = () => ({ sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 'x' } }] }] }] }] });
    const funnel = (await ctx.api('post', '/funnels').send({ name: 'Menu Funnel' })).body.funnel;
    await ctx.api('post', `/funnels/${funnel.id}/steps`).send({ key: 'checkout', stepType: 'checkout', name: 'C', builderData: tree() });
    await ctx.api('post', `/funnels/${funnel.id}/steps`).send({ key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree() });
    await ctx.api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'checkout', toStepKey: 'thanks', condition: { type: 'always' } });
    expect((await ctx.api('post', `/funnels/${funnel.id}/publish`).send({})).status).toBe(201);

    expect((await buyNow(ctx, undefined, 1, { funnelId: funnel.id })).status).toBe(422);
    const ok = await buyNow(ctx, [ctx.pick.large, ctx.pick.cheeseOlives], 1, { funnelId: funnel.id });
    expect(ok.status).toBe(201);
    expect(Number((await db.Order.findByPk(ok.body.order.id)).totalAmount)).toBe(14500);
  });

  it('charges an InstaPay (manual payment) order the menu total too', async () => {
    const ctx = await setup();
    const method = await request(app)
      .post(`/api/v1/workspaces/${ctx.ws}/manual-payments/methods`)
      .set({ Authorization: `Bearer ${ctx.auth.accessToken}` })
      .send({ kind: 'instapay', label: 'InstaPay', accountNumber: 'store@instapay' });
    expect(method.status).toBe(201);
    const res = await buyNow(ctx, [ctx.pick.large], 1, { paymentMethod: 'bank_transfer', manualPaymentMethodId: method.body.method.id });
    expect(res.status).toBe(201);
    const order = await db.Order.findByPk(res.body.order.id);
    expect(order.paymentMethod).toBe('bank_transfer');
    expect(Number(order.totalAmount)).toBe(13000);
  });

  it('shows the picks on the delivery sheet and the waybill', async () => {
    const ctx = await setup();
    const res = await buyNow(ctx, [ctx.pick.large, ctx.pick.cheeseOlives], 2);
    const id = res.body.order.id;
    await db.Shipment.create({ workspaceId: ctx.ws, orderId: id, carrierCode: 'Ahmed', status: 'created', trackingCode: `T${Date.now()}` });
    const sheet = await orderDocuments.manifestRows(ctx.ws, { orderIds: [id] });
    expect(sheet.rows[0].items).toContain('الحجم: كبير');
    expect(sheet.rows[0].items).toContain('إضافات: جبنة, زيتون');
    const lines = await customDataLines(id);
    expect(lines.join('\n')).toContain('الحجم: كبير');
  });
});
