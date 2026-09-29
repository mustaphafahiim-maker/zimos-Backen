'use strict';

// The merchant's collection tree: parents (no cycles, at most three levels),
// sibling order, product order inside a collection, and that none of it can
// reach another store's collections or products.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

async function setup() {
  const ctx = await setupWorkspaceWithProduct();
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  const base = `/api/v1/workspaces/${ctx.workspace.id}/catalog`;
  const create = async (body) => {
    const res = await request(app).post(`${base}/collections`).set(H).send(body);
    if (res.status !== 201) throw new Error(`create collection: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.collection;
  };
  return { ...ctx, H, base, create };
}

describe('collection tree', () => {
  it('nests collections up to three levels and refuses a fourth', async () => {
    const ctx = await setup();
    const men = await ctx.create({ name: 'Men' });
    const shirts = await ctx.create({ name: 'Shirts', parentId: men.id });
    const linen = await ctx.create({ name: 'Linen', parentId: shirts.id, imageUrl: 'https://cdn.example/linen.jpg' });
    expect(shirts.parentId).toBe(men.id);
    expect(linen.imageUrl).toBe('https://cdn.example/linen.jpg');

    const tooDeep = await request(app).post(`${ctx.base}/collections`).set(ctx.H).send({ name: 'Summer', parentId: linen.id });
    expect(tooDeep.status).toBe(422);
    expect(tooDeep.body.error.code).toBe('COLLECTION_TOO_DEEP');

    // Moving a parent with two levels under it below another collection would make four.
    const other = await ctx.create({ name: 'Sale' });
    const move = await request(app).patch(`${ctx.base}/collections/${men.id}`).set(ctx.H).send({ parentId: other.id });
    expect(move.status).toBe(422);
    expect(move.body.error.code).toBe('COLLECTION_TOO_DEEP');
  });

  it('refuses a cycle, by patch and by reorder', async () => {
    const ctx = await setup();
    const a = await ctx.create({ name: 'A' });
    const b = await ctx.create({ name: 'B', parentId: a.id });

    const self = await request(app).patch(`${ctx.base}/collections/${a.id}`).set(ctx.H).send({ parentId: a.id });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('COLLECTION_CYCLE');

    const loop = await request(app).patch(`${ctx.base}/collections/${a.id}`).set(ctx.H).send({ parentId: b.id });
    expect(loop.body.error.code).toBe('COLLECTION_CYCLE');

    const bulk = await request(app)
      .post(`${ctx.base}/collections/reorder`)
      .set(ctx.H)
      .send({ items: [{ id: a.id, parentId: b.id }, { id: b.id, parentId: a.id }] });
    expect(bulk.status).toBe(422);
    expect(bulk.body.error.code).toBe('COLLECTION_CYCLE');
    // Nothing moved.
    expect((await db.Collection.findByPk(a.id)).parentId).toBeNull();
  });

  it('lists siblings by position, then name, and reorders the tree in one request', async () => {
    const ctx = await setup();
    const zed = await ctx.create({ name: 'Zed' });
    const alpha = await ctx.create({ name: 'Alpha' });
    const beta = await ctx.create({ name: 'Beta', position: 0 });

    // New collections go after their siblings; ties sort by name.
    let list = (await request(app).get(`${ctx.base}/collections`).set(ctx.H)).body.collections;
    expect(list.map((c) => c.name)).toEqual(['Beta', 'Zed', 'Alpha']);

    const res = await request(app)
      .post(`${ctx.base}/collections/reorder`)
      .set(ctx.H)
      .send({
        items: [
          { id: alpha.id, parentId: null, position: 0 },
          { id: zed.id, parentId: null, position: 1 },
          { id: beta.id, parentId: alpha.id, position: 0 },
        ],
      });
    expect(res.status).toBe(200);
    list = (await request(app).get(`${ctx.base}/collections`).set(ctx.H)).body.collections;
    const top = list.filter((c) => !c.parentId).map((c) => c.name);
    expect(top).toEqual(['Alpha', 'Zed']);
    expect(list.find((c) => c.id === beta.id).parentId).toBe(alpha.id);
    expect(typeof list[0].productCount).toBe('number');
  });

  it('keeps products in the collection in the merchant’s order', async () => {
    const ctx = await setup();
    const c = await ctx.create({ name: 'Picks' });
    const second = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id);
    const third = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id);
    for (const product of [ctx.product, second.product, third.product]) {
      await request(app).post(`${ctx.base}/products/${product.id}/collections/${c.id}`).set(ctx.H).expect(200);
    }
    let got = (await request(app).get(`${ctx.base}/collections/${c.id}`).set(ctx.H)).body.collection;
    expect(got.products.map((p) => p.id)).toEqual([ctx.product.id, second.product.id, third.product.id]);

    const res = await request(app)
      .put(`${ctx.base}/collections/${c.id}/products/order`)
      .set(ctx.H)
      .send({ productIds: [third.product.id, ctx.product.id] });
    expect(res.status).toBe(200);
    // The one left out keeps its place after the listed ones.
    expect(res.body.productIds).toEqual([third.product.id, ctx.product.id, second.product.id]);
    got = (await request(app).get(`${ctx.base}/collections/${c.id}`).set(ctx.H)).body.collection;
    expect(got.products.map((p) => p.id)).toEqual([third.product.id, ctx.product.id, second.product.id]);
  });

  it('never reaches another store', async () => {
    const ctx = await setup();
    const other = await setup();
    const mine = await ctx.create({ name: 'Mine' });
    const theirs = await other.create({ name: 'Theirs' });

    const parent = await request(app).patch(`${ctx.base}/collections/${mine.id}`).set(ctx.H).send({ parentId: theirs.id });
    expect(parent.status).toBe(422);
    expect(parent.body.error.code).toBe('COLLECTION_PARENT_NOT_FOUND');

    const reorder = await request(app)
      .post(`${ctx.base}/collections/reorder`)
      .set(ctx.H)
      .send({ items: [{ id: theirs.id, position: 5 }] });
    expect(reorder.status).toBe(422);
    expect((await db.Collection.findByPk(theirs.id)).position).toBe(0);

    await request(app).post(`${other.base}/products/${other.product.id}/collections/${theirs.id}`).set(other.H).expect(200);
    const order = await request(app)
      .put(`${ctx.base}/collections/${theirs.id}/products/order`)
      .set(ctx.H)
      .send({ productIds: [other.product.id] });
    expect(order.status).toBe(404);
  });

  it('gives an all-Arabic collection a readable slug', async () => {
    const ctx = await setup();
    const first = await ctx.create({ name: 'قمصان' });
    const second = await ctx.create({ name: 'بناطيل' });
    expect(first.slug).toBe('collection');
    expect(second.slug).toBe('collection-2');
  });

  it('lists the option names in use', async () => {
    const ctx = await setup();
    await db.ProductVariant.update({ optionValues: { Size: 'M', Color: 'Red' } }, { where: { id: ctx.variant.id } });
    await request(app).patch(`${ctx.base}/products/${ctx.product.id}`).set(ctx.H).send({ status: 'active' });
    const res = await request(app).get(`${ctx.base}/option-names`).set(ctx.H);
    expect(res.status).toBe(200);
    expect(res.body.options.map((o) => o.name).sort()).toEqual(['Color', 'Size']);
  });
});
