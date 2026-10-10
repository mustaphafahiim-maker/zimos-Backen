'use strict';

// Price history (modules/priceHistory, STORE_FEATURES price_history).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

describe('price history', () => {
  it('is off until STORE_FEATURES names it, and records nothing meanwhile', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const variant = await db.ProductVariant.findOne({ where: { productId: product.id } });
    await variant.update({ priceAmount: Number(variant.priceAmount) + 100 });

    const staff = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/price-history/variants/${variant.id}`)
      .set('Authorization', `Bearer ${auth.accessToken}`);
    expect(staff.status).toBe(404);
    expect(staff.body.error.code).toBe('FEATURE_UNAVAILABLE');
    const store = await request(app).get(`/api/v1/store/${workspace.id}/lowest-prices`).query({ variantIds: variant.id });
    expect(store.status).toBe(404);

    const [rows] = await db.sequelize.query('SELECT count(*)::int AS n FROM variant_price_history WHERE variant_id = :v', { replacements: { v: variant.id } });
    expect(rows[0].n).toBe(0);
  });

  it('records each price change and gives the lowest price of the last 30 days', async () => {
    env.storeFeatures.push('price_history');
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const variant = await db.ProductVariant.findOne({ where: { productId: product.id } });
    const start = Number(variant.priceAmount);

    await variant.update({ priceAmount: start - 500 });
    await variant.update({ priceAmount: start + 1000 });
    // Saving the same price again is not a change.
    await variant.update({ priceAmount: start + 1000 });

    const staff = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/price-history/variants/${variant.id}`)
      .set('Authorization', `Bearer ${auth.accessToken}`);
    expect(staff.status).toBe(200);
    // The first row is the price the variant was created with.
    expect(staff.body.changes.map((c) => c.priceAmount)).toEqual([String(start), String(start - 500), String(start + 1000)]);
    expect(staff.body.current.priceAmount).toBe(String(start + 1000));
    expect(staff.body.lowest30Days).toBe(String(start - 500));

    const store = await request(app).get(`/api/v1/store/${workspace.id}/lowest-prices`).query({ variantIds: variant.id });
    expect(store.status).toBe(200);
    expect(store.body).toEqual({ days: 30, prices: { [variant.id]: String(start - 500) } });

    const bad = await request(app).get(`/api/v1/store/${workspace.id}/lowest-prices`).query({ variantIds: 'nope' });
    expect(bad.status).toBe(422);
  });
});
