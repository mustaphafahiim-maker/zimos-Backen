'use strict';

// Product specifications and comparison (modules/productSpecs, STORE_FEATURES product_specs).

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

describe('product specifications', () => {
  it('are off until STORE_FEATURES names them', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const staff = await request(app).get(`/api/v1/workspaces/${workspace.id}/product-specs/keys`).set('Authorization', `Bearer ${auth.accessToken}`);
    expect(staff.status).toBe(404);
    expect(staff.body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await request(app).get(`/api/v1/store/${workspace.id}/specs/products/${product.id}`)).status).toBe(404);
  });

  it('keys, values per product, storefront filters and a side-by-side compare', async () => {
    env.storeFeatures.push('product_specs');
    const { auth, workspace, product: a } = await setupWorkspaceWithProduct();
    const { product: b } = await createProductWithVariant(auth.accessToken, workspace.id);
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}/product-specs`;
    const store = `/api/v1/store/${workspace.id}/specs`;

    const material = (await request(app).post(`${base}/keys`).set(H).send({ name: { en: 'Material', ar: 'الخامة' }, filterable: true })).body.key;
    const weight = (await request(app).post(`${base}/keys`).set(H).send({ name: { en: 'Weight' }, unit: 'g', position: 1 })).body.key;
    expect(material.filterable).toBe(true);

    const unknown = await request(app).put(`${base}/products/${a.id}`).set(H).send({ values: { '00000000-0000-4000-8000-000000000000': 'x' } });
    expect(unknown.status).toBe(422);
    expect((await request(app).put(`${base}/products/${a.id}`).set(H).send({ values: { [material.id]: 'Cotton', [weight.id]: '200' } })).status).toBe(200);
    await request(app).put(`${base}/products/${b.id}`).set(H).send({ values: { [material.id]: 'Linen', [weight.id]: '200' } });

    const specs = await request(app).get(`${store}/products/${a.id}`);
    expect(specs.body.specs.map((s) => [s.name.en, s.value])).toEqual([['Material', 'Cotton'], ['Weight', '200']]);

    const filters = await request(app).get(`${store}/filters`);
    expect(filters.body.filters).toEqual([expect.objectContaining({ id: material.id, values: [{ value: 'Cotton', products: 1 }, { value: 'Linen', products: 1 }] })]);

    const matching = await request(app).get(`${store}/products`).query({ f: `${material.id}:Linen` });
    expect(matching.body.total).toBe(1);
    expect(matching.body.products[0].id).toBe(b.id);

    const compare = await request(app).get(`${store}/compare`).query({ productIds: `${a.id},${b.id}` });
    expect(compare.status).toBe(200);
    const differs = Object.fromEntries(compare.body.keys.map((k) => [k.name.en, k.differs]));
    expect(differs).toEqual({ Material: true, Weight: false });
    expect((await request(app).get(`${store}/compare`).query({ productIds: a.id })).status).toBe(422);
  });
});
