'use strict';

// Merchant ad pixels: validated IDs saved in workspace settings and exposed
// (IDs only) on the public store meta so the storefront can load them.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('tracking pixels', () => {
  it('saves valid pixel IDs and exposes only them on the store', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken);

    const bad = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(bearer(auth.accessToken))
      .send({ settings: { tracking_pixels: { meta: 'not-a-pixel' } } });
    expect(bad.status).toBe(422);

    const ok = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(bearer(auth.accessToken))
      .send({ settings: { tracking_pixels: { meta: '123456789012345', tiktok: 'C4ABCDEF1234567890', google_tag: 'G-ABC123XYZ' }, free_shipping_threshold_amount: 50000 } });
    expect(ok.status).toBe(200);

    const store = await request(app).get(`/api/v1/store/${workspace.id}`);
    expect(store.status).toBe(200);
    expect(store.body.store.tracking).toEqual({ meta: '123456789012345', tiktok: 'C4ABCDEF1234567890', googleTag: 'G-ABC123XYZ' });
    expect(store.body.store.settings).toBeUndefined();

    const cleared = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(bearer(auth.accessToken))
      .send({ settings: { tracking_pixels: null } });
    expect(cleared.status).toBe(200);
    const after = await request(app).get(`/api/v1/store/${workspace.id}`);
    expect(after.body.store.tracking).toEqual({});
  });
});
