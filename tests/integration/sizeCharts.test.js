'use strict';

// Size charts (modules/sizeCharts, STORE_FEATURES size_charts).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const chart = (productIds = [], collectionIds = []) => ({
  name: 'Shirts',
  unit: 'cm',
  columns: [{ ar: 'المقاس', en: 'Size' }, { ar: 'الصدر', en: 'Chest' }],
  rows: [['S', '96'], ['M', '100']],
  productIds,
  collectionIds,
});

describe('size charts', () => {
  it('are off until STORE_FEATURES names them', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const staff = await request(app).get(`/api/v1/workspaces/${workspace.id}/size-charts`).set('Authorization', `Bearer ${auth.accessToken}`);
    expect(staff.status).toBe(404);
    expect(staff.body.error.code).toBe('FEATURE_UNAVAILABLE');
    const store = await request(app).get(`/api/v1/store/${workspace.id}/size-chart`).query({ productId: product.id });
    expect(store.status).toBe(404);
  });

  it('a product shows its own chart, else one of its collections', async () => {
    env.storeFeatures.push('size_charts');
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}/size-charts`;

    const bad = await request(app).post(base).set(H).send({ ...chart(), rows: [['S']] });
    expect(bad.status).toBe(422);

    const collection = await db.Collection.create({ workspaceId: workspace.id, name: 'Tops', slug: `tops-${Date.now()}` });
    await db.ProductCollection.create({ productId: product.id, collectionId: collection.id });
    const byCollection = await request(app).post(base).set(H).send({ ...chart([], [collection.id]), name: 'Tops chart' });
    expect(byCollection.status).toBe(201);

    const shown = await request(app).get(`/api/v1/store/${workspace.id}/size-chart`).query({ productId: product.id });
    expect(shown.status).toBe(200);
    expect(shown.body.sizeChart).toMatchObject({ name: 'Tops chart', unit: 'cm' });

    const own = await request(app).post(base).set(H).send({ ...chart([product.id]), name: 'Own chart' });
    expect(own.status).toBe(201);
    const ownShown = await request(app).get(`/api/v1/store/${workspace.id}/size-chart`).query({ productId: product.id });
    expect(ownShown.body.sizeChart.name).toBe('Own chart');

    expect((await request(app).get(base).set(H)).body.sizeCharts).toHaveLength(2);
    expect((await request(app).delete(`${base}/${own.body.id}`).set(H)).status).toBe(204);
  });
});
