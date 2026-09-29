'use strict';

// Storefront search, filters, sort, facets and suggestions
// (GET /store/:id/products with the listing params, GET .../products/suggest).

const express = require('express');
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { generateProductCode } = require('../../src/modules/catalog/catalogService');
const { createSuggestLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

let seq = 0;

/** A product straight in the database: faster than the API, and variants can carry options. */
async function product(workspaceId, { name, tags = [], description = null, status = 'active', variants = [{}], createdAt }) {
  seq += 1;
  const row = await db.Product.create({
    workspaceId,
    name,
    slug: `p-${seq}-${Date.now()}`,
    productCode: generateProductCode(),
    status,
    tags,
    description,
    ...(createdAt ? { createdAt } : {}),
  });
  for (const [i, v] of variants.entries()) {
    await db.ProductVariant.create({
      workspaceId,
      productId: row.id,
      sku: v.sku === undefined ? `SKU-${seq}-${i}` : v.sku,
      priceAmount: v.price ?? 10000,
      optionValues: v.options || {},
      stockOnHand: 5,
    });
  }
  return row;
}

async function collection(workspaceId, name, parentId = null, position = 0) {
  seq += 1;
  return db.Collection.create({ workspaceId, name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${seq}`, parentId, position });
}

const link = (productRow, collectionRow, position = 0) =>
  db.ProductCollection.create({ productId: productRow.id, collectionId: collectionRow.id, position });

async function store() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Search Store');
  return { owner, workspace, id: workspace.id };
}

const list = (ws, query) => request(app).get(`/api/v1/store/${ws}/products`).query(query);
const names = (res) => res.body.products.map((p) => p.name);

describe('storefront search', () => {
  it('folds Arabic spelling on both sides', async () => {
    const s = await store();
    await product(s.id, { name: 'ساعة أحمد الذهبية' });
    await product(s.id, { name: 'مَكتبة خشب' });
    await product(s.id, { name: 'كرسي' });

    for (const typed of ['ساعه احمد', 'ساعة أحمد', 'اَحْمَد', 'الذهبيه']) {
      const res = await list(s.id, { search: typed });
      expect(res.status).toBe(200);
      expect(names(res)).toEqual(['ساعة أحمد الذهبية']);
    }
    expect(names(await list(s.id, { search: 'مكتبه' }))).toEqual(['مَكتبة خشب']);
    // alef maqsura typed as yaa
    await product(s.id, { name: 'مستشفى الحيوان' });
    expect(names(await list(s.id, { search: 'مستشفي' }))).toEqual(['مستشفى الحيوان']);
  });

  it('puts exact, then prefix, then contained names first, and matches English in any case', async () => {
    const s = await store();
    await product(s.id, { name: 'Classic Mug', createdAt: new Date(Date.now() - 3000) });
    await product(s.id, { name: 'Mug', createdAt: new Date(Date.now() - 2000) });
    await product(s.id, { name: 'Mugs gift box', createdAt: new Date(Date.now() - 1000) });
    await product(s.id, { name: 'Teapot', description: 'Pairs well with any mug' });

    const res = await list(s.id, { search: 'MUG' });
    expect(res.body.sort).toBe('relevance');
    expect(names(res)).toEqual(['Mug', 'Mugs gift box', 'Classic Mug', 'Teapot']);
    expect(res.body.matches.map((p) => p.name)).toEqual(names(res));
    expect(res.body.total).toBe(4);
  });

  it('forgives a small typo', async () => {
    const s = await store();
    await product(s.id, { name: 'iPhone 15 Pro' });
    await product(s.id, { name: 'سماعة بلوتوث لاسلكية' });
    await product(s.id, { name: 'Laptop stand' });
    expect(names(await list(s.id, { search: 'iphnoe' }))).toEqual(['iPhone 15 Pro']);
    expect(names(await list(s.id, { search: 'سماعه بلوتوت' }))).toEqual(['سماعة بلوتوث لاسلكية']);
  });

  it('treats % and _ as plain text', async () => {
    const s = await store();
    await product(s.id, { name: 'Summer 50%_off pack' });
    await product(s.id, { name: 'Summer 500 pack' });
    await product(s.id, { name: 'Summer 50xxoff pack' });
    // A wildcard would let "50%_off" match "Summer 500 pack"; the near spelling
    // "50xxoff" may still come after it as a typo-tolerant match.
    const res = await list(s.id, { search: '50%_off' });
    expect(names(res)[0]).toBe('Summer 50%_off pack');
    expect(names(res)).not.toContain('Summer 500 pack');
    // One character has no trigrams, so only a literal match can answer.
    expect(names(await list(s.id, { search: '%' }))).toEqual(['Summer 50%_off pack']);
    expect(names(await list(s.id, { search: '_' }))).toEqual(['Summer 50%_off pack']);
  });

  it('finds by SKU and tag, and lists related products after the matches without repeating one', async () => {
    const s = await store();
    const sale = await collection(s.id, 'Kitchen');
    const kettle = await product(s.id, { name: 'Steel kettle', tags: ['kitchen'], variants: [{ sku: 'KT-900' }] });
    const pan = await product(s.id, { name: 'Frying pan', tags: ['kitchen'] });
    const board = await product(s.id, { name: 'Cutting board' });
    await product(s.id, { name: 'Desk lamp', tags: ['office'] });
    await link(kettle, sale);
    await link(board, sale);

    const bySku = await list(s.id, { search: 'kt-900' });
    expect(names(bySku)).toEqual(['Steel kettle']);
    const relatedNames = bySku.body.related.map((p) => p.name).sort();
    // Same collection (board) and same tag (pan); never the lamp, never the kettle itself.
    expect(relatedNames).toEqual(['Cutting board', 'Frying pan']);
    expect(bySku.body.related.map((p) => p.id)).not.toContain(kettle.id);

    const byTag = await list(s.id, { search: 'office' });
    expect(names(byTag)).toEqual(['Desk lamp']);
    expect(pan).toBeTruthy();
  });

  it('offers the nearest names when nothing matches', async () => {
    const s = await store();
    await product(s.id, { name: 'Wireless keyboard' });
    const res = await list(s.id, { search: 'keybrd wireles' });
    expect(res.status).toBe(200);
    // Either a match or a near one — the shopper never lands on an empty page for a near miss.
    expect([...names(res), ...res.body.related.map((p) => p.name)]).toContain('Wireless keyboard');
  });

  it("never shows another store's products, or drafts", async () => {
    const s = await store();
    const other = await store();
    await product(s.id, { name: 'Blue scarf' });
    await product(s.id, { name: 'Blue hat', status: 'draft' });
    await product(other.id, { name: 'Blue coat' });
    expect(names(await list(s.id, { search: 'blue' }))).toEqual(['Blue scarf']);
    const suggestions = await request(app).get(`/api/v1/store/${s.id}/products/suggest`).query({ q: 'blue' });
    expect(suggestions.body.products.map((p) => p.name)).toEqual(['Blue scarf']);
  });
});

describe('storefront filters, sort and facets', () => {
  async function catalogue() {
    const s = await store();
    const men = await collection(s.id, 'Men', null, 0);
    const shirts = await collection(s.id, 'Shirts', men.id, 0);
    const women = await collection(s.id, 'Women', null, 1);
    const linen = await product(s.id, {
      name: 'Linen shirt',
      tags: ['summer', 'linen'],
      createdAt: new Date(Date.now() - 5000),
      variants: [
        { price: 45000, options: { Size: 'M', Color: 'White' } },
        { price: 47000, options: { Size: 'L', Color: 'Blue' } },
      ],
    });
    const oxford = await product(s.id, {
      name: 'Oxford shirt',
      tags: ['formal'],
      createdAt: new Date(Date.now() - 4000),
      variants: [{ price: 60000, options: { Size: 'M', Color: 'Blue' } }],
    });
    const jacket = await product(s.id, {
      name: 'Denim jacket',
      tags: ['winter'],
      createdAt: new Date(Date.now() - 3000),
      variants: [{ price: 90000, options: { Size: 'L', Color: 'Blue' } }],
    });
    const dress = await product(s.id, {
      name: 'Summer dress',
      tags: ['summer'],
      createdAt: new Date(Date.now() - 2000),
      variants: [{ price: 30000, options: { Size: 'S', Color: 'Red' } }],
    });
    await link(linen, shirts, 1);
    await link(oxford, shirts, 0);
    await link(jacket, men, 0);
    await link(dress, women, 0);
    return { ...s, men, shirts, women, linen, oxford, jacket, dress };
  }

  it("filters by a collection, its sub-collections included, by slug or id, with breadcrumbs", async () => {
    const c = await catalogue();
    const res = await list(c.id, { collection: c.men.slug, sort: 'name' });
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Denim jacket', 'Linen shirt', 'Oxford shirt']);
    expect(res.body.collection.id).toBe(c.men.id);

    const deep = await list(c.id, { collection: c.shirts.id, sort: 'position' });
    expect(names(deep)).toEqual(['Oxford shirt', 'Linen shirt']);
    expect(deep.body.breadcrumbs.map((b) => b.name)).toEqual(['Men', 'Shirts']);

    const missing = await list(c.id, { collection: 'no-such-collection' });
    expect(missing.status).toBe(404);
  });

  it('filters by tags, price and options on one variant', async () => {
    const c = await catalogue();
    expect(names(await list(c.id, { tag: ['summer', 'winter'], sort: 'name' }))).toEqual([
      'Denim jacket',
      'Linen shirt',
      'Summer dress',
    ]);
    expect(names(await list(c.id, { minPrice: 40000, maxPrice: 60000, sort: 'price_asc' }))).toEqual([
      'Linen shirt',
      'Oxford shirt',
    ]);
    // Size M in Blue exists only on the Oxford shirt: the linen shirt's M is White.
    const res = await request(app).get(`/api/v1/store/${c.id}/products?option[Size]=M&option[Color]=Blue&sort=name`);
    expect(names(res)).toEqual(['Oxford shirt']);
    const either = await request(app).get(`/api/v1/store/${c.id}/products?option[Size]=S,L&sort=name`);
    expect(names(either)).toEqual(['Denim jacket', 'Linen shirt', 'Summer dress']);
  });

  it('sorts and pages, with a total', async () => {
    const c = await catalogue();
    expect(names(await list(c.id, { sort: 'newest' }))).toEqual(['Summer dress', 'Denim jacket', 'Oxford shirt', 'Linen shirt']);
    expect(names(await list(c.id, { sort: 'price_desc' }))[0]).toBe('Denim jacket');
    const first = await list(c.id, { sort: 'name', limit: 3, page: 1 });
    expect(first.body).toMatchObject({ total: 4, page: 1, hasMore: true });
    const second = await list(c.id, { sort: 'name', limit: 3, page: 2 });
    expect(names(second)).toEqual(['Summer dress']);
    expect(second.body.hasMore).toBe(false);
  });

  it('counts each filter value, a parent collection including its sub-collections', async () => {
    const c = await catalogue();
    const res = await list(c.id, { facets: true, tag: ['summer'] });
    const { facets } = res.body;
    const count = (id) => facets.collections.find((x) => x.id === id).count;
    // The tag filter is applied to the collection counts...
    expect(count(c.men.id)).toBe(1);
    expect(count(c.women.id)).toBe(1);
    // ...but not to the tag counts themselves, so the shopper can widen the choice.
    expect(facets.tags).toEqual(expect.arrayContaining([{ value: 'winter', count: 1 }, { value: 'summer', count: 2 }]));
    const size = facets.options.find((o) => o.name === 'Size');
    expect(size.values).toEqual(expect.arrayContaining([{ value: 'M', count: 1 }, { value: 'S', count: 1 }]));
    expect(facets.price).toEqual({ min: 30000, max: 47000 });
  });

  it('keeps the plain listing exactly as before', async () => {
    const c = await catalogue();
    const res = await list(c.id, { limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.nextCursor).toBeTruthy();
    expect(res.body).not.toHaveProperty('total');
    const next = await list(c.id, { limit: 2, cursor: res.body.nextCursor });
    expect(next.body.products).toHaveLength(2);
  });

  it('publishes the collection tree in order, and finds one by slug', async () => {
    const c = await catalogue();
    const res = await request(app).get(`/api/v1/store/${c.id}/collections`);
    expect(res.body.collections.map((x) => x.name)).toEqual(['Men', 'Shirts', 'Women']);
    expect(res.body.collections.find((x) => x.name === 'Shirts').parentId).toBe(c.men.id);
    const one = await request(app).get(`/api/v1/store/${c.id}/collections/${c.women.slug}`);
    expect(one.body.collection.id).toBe(c.women.id);
  });
});

describe('storefront search suggestions', () => {
  it('returns at most eight, collections first, each with what a row needs', async () => {
    const s = await store();
    await collection(s.id, 'Shoes');
    await collection(s.id, 'Shoe care');
    for (let i = 0; i < 9; i += 1) await product(s.id, { name: `Shoe ${i}`, variants: [{ price: 1000 + i }] });
    const res = await request(app).get(`/api/v1/store/${s.id}/products/suggest`).query({ q: 'shoe' });
    expect(res.status).toBe(200);
    expect(res.body.collections.map((c) => c.name).sort()).toEqual(['Shoe care', 'Shoes']);
    expect(res.body.products).toHaveLength(6);
    expect(res.body.products[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), name: expect.stringMatching(/^Shoe/), priceAmount: expect.any(String) })
    );
    const empty = await request(app).get(`/api/v1/store/${s.id}/products/suggest`).query({ q: '  ' });
    expect(empty.body).toEqual({ query: '', products: [], collections: [] });
  });

  it('is rate limited per shopper, by the minute', async () => {
    const limited = express();
    limited.set('trust proxy', 1);
    limited.get('/suggest', createSuggestLimiter({ minuteMax: 3, hourMax: 100 }), (req, res) => res.json({ ok: true }));
    limited.use(errorHandler);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await request(limited).get('/suggest').set('X-Forwarded-For', '203.0.113.7')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Another shopper has their own bucket.
    expect((await request(limited).get('/suggest').set('X-Forwarded-For', '203.0.113.8')).status).toBe(200);
  });
});

describe('storefront catalog settings', () => {
  it('saves the sidebar, filters and default sort, and hands them to the storefront', async () => {
    const s = await store();
    const H = { Authorization: `Bearer ${s.owner.accessToken}` };
    const before = await request(app).get(`/api/v1/store/${s.id}`);
    expect(before.body.store.catalog).toEqual({
      sidebar_enabled: true,
      default_sort: 'newest',
      filters: [{ key: 'collections' }, { key: 'price' }, { key: 'options' }, { key: 'tags' }],
    });

    const catalog = {
      sidebar_enabled: true,
      default_sort: 'price_asc',
      filters: [{ key: 'price' }, { key: 'option', name: 'Size' }, { key: 'collections' }],
    };
    const saved = await request(app).patch(`/api/v1/workspaces/${s.id}`).set(H).send({ settings: { storefront_catalog: catalog } });
    expect(saved.status).toBe(200);
    expect((await request(app).get(`/api/v1/store/${s.id}`)).body.store.catalog).toEqual(catalog);

    const bad = await request(app)
      .patch(`/api/v1/workspaces/${s.id}`)
      .set(H)
      .send({ settings: { storefront_catalog: { sidebar_enabled: true, default_sort: 'random', filters: [] } } });
    expect(bad.status).toBe(422);
    const optionWithoutName = await request(app)
      .patch(`/api/v1/workspaces/${s.id}`)
      .set(H)
      .send({ settings: { storefront_catalog: { sidebar_enabled: false, default_sort: 'name', filters: [{ key: 'option' }] } } });
    expect(optionWithoutName.status).toBe(422);
  });
});
