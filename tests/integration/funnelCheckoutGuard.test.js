'use strict';

// A storefront checkout that names a funnel (funnels/funnelCheckout.js, behind
// FUNNEL_CHECKOUT_GUARD): the funnel must be a published one of this store
// that sells the lines, or its shipping prices and funnel-only coupons are not
// for this cart. Off, a funnelId is taken as before.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.funnelCheckout.guard = false;
});

async function store() {
  const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 20 });
  const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 20 });
  return { ...ctx, b };
}

async function funnel(ctx, { status = 'published', builderData }) {
  const f = await db.Funnel.create({ workspaceId: ctx.workspace.id, name: `F ${Math.random()}`, status });
  if (status === 'draft') return f;
  const revision = await db.FunnelRevision.create({
    workspaceId: ctx.workspace.id,
    funnelId: f.id,
    revisionNumber: 1,
    snapshot: { funnel: { id: f.id }, steps: [{ key: 'checkout', builderData }], edges: [] },
    publishedByUserId: ctx.auth.userId,
  });
  await f.update({ publishedRevisionId: revision.id });
  return f;
}

const checkout = (ctx, variantId, funnelId) =>
  request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `fg-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ item: { variantId, quantity: 1 }, contact: { fullName: 'Funnel Buyer', phone: '01033337777' }, paymentMethod: 'cod', funnelId });

describe('a checkout naming a funnel', () => {
  it('with the guard on: refuses an unknown or draft funnel, and lines the funnel does not sell', async () => {
    env.funnelCheckout.guard = true;
    const ctx = await store();
    const sellsA = await funnel(ctx, { builderData: { productId: ctx.product.id, sections: [] } });
    const draft = await funnel(ctx, { status: 'draft' });

    const unknown = await checkout(ctx, ctx.variant.id, '00000000-0000-4000-8000-000000000001');
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('FUNNEL_NOT_AVAILABLE');

    const notPublished = await checkout(ctx, ctx.variant.id, draft.id);
    expect(notPublished.body.error.code).toBe('FUNNEL_NOT_AVAILABLE');

    const otherProduct = await checkout(ctx, ctx.b.variant.id, sellsA.id);
    expect(otherProduct.status).toBe(422);
    expect(otherProduct.body.error.code).toBe('FUNNEL_ITEM_NOT_OFFERED');

    const own = await checkout(ctx, ctx.variant.id, sellsA.id);
    expect(own.status).toBe(201);
  });

  it('a funnel page that shows the catalogue sells any of the store products', async () => {
    env.funnelCheckout.guard = true;
    const ctx = await store();
    const catalogue = await funnel(ctx, { builderData: { sections: [{ type: 'product_list', props: { limit: 8 } }] } });
    expect((await checkout(ctx, ctx.b.variant.id, catalogue.id)).status).toBe(201);
  });

  it('with the guard off (the default), a funnelId is taken as before', async () => {
    const ctx = await store();
    const sellsA = await funnel(ctx, { builderData: { productId: ctx.product.id, sections: [] } });
    expect((await checkout(ctx, ctx.b.variant.id, sellsA.id)).status).toBe(201);
  });
});
