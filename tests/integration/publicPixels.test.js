'use strict';

// The storefront's store info carries the store's browser pixels (marketing/trackingPixelService.publicPixels).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

describe('store info with tracking pixels', () => {
  it('a store with an active pixel still answers, and lists it', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    await db.TrackingPixel.create({ workspaceId: workspace.id, platform: 'meta', pixelId: '123456789012', scopeType: 'all', scopeIds: [], isActive: true, config: {} });
    await db.TrackingPixel.create({ workspaceId: workspace.id, platform: 'clarity', pixelId: 'abcd1234', scopeType: 'all', scopeIds: [], isActive: true, config: {} });
    const res = await request(app).get(`/api/v1/store/${workspace.id}`);
    expect(res.status).toBe(200);
    expect(res.body.store.trackingPixels.map((p) => p.platform)).toEqual(['meta', 'clarity']);
    expect(res.body.store.tracking).toMatchObject({ meta: '123456789012' });
  });
});
