'use strict';

// Low-stock threshold is stored per variant (not in the browser).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('variant low-stock threshold', () => {
  it('is saved on the variant and returned with the product', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();

    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`)
      .set(bearer(auth.accessToken))
      .send({ lowStockThreshold: 7 });
    expect(res.status).toBe(200);
    expect(res.body.variant.lowStockThreshold).toBe(7);

    const got = await request(app).get(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`).set(bearer(auth.accessToken));
    const v = got.body.product.variants.find((x) => x.id === variant.id);
    expect(v.lowStockThreshold).toBe(7);

    const cleared = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`)
      .set(bearer(auth.accessToken))
      .send({ lowStockThreshold: null });
    expect(cleared.body.variant.lowStockThreshold).toBeNull();

    const bad = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`)
      .set(bearer(auth.accessToken))
      .send({ lowStockThreshold: -1 });
    expect(bad.status).toBe(422);
  });
});
