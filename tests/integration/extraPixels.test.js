'use strict';

// Extra ad pixels (STORE_FEATURES extra_pixels): X, Reddit, Microsoft, Pinterest (browser + server, sandbox
// until *_CAPI_MODE=live) and Taboola, Outbrain, Kwai (browser only).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const pixels = require('../../src/modules/marketing/trackingPixelService');

afterEach(() => {
  env.storeFeatures.length = 0;
});

async function store() {
  const ctx = await setupWorkspaceWithProduct();
  return { ...ctx, H: { Authorization: `Bearer ${ctx.auth.accessToken}` }, base: `/api/v1/workspaces/${ctx.workspace.id}/tracking-pixels` };
}

describe('extra ad pixels', () => {
  it('off: not offered, refused, and a stored one is neither loaded nor sent to', async () => {
    const { workspace, H, base } = await store();
    const list = await request(app).get(base).set(H);
    expect(list.body.platforms.map((p) => p.name)).not.toContain('reddit');
    const made = await request(app).post(base).set(H).send({ platform: 'reddit', pixelId: 't2_abc123' });
    expect(made.status).toBe(422);

    await db.TrackingPixel.create({ workspaceId: workspace.id, platform: 'reddit', pixelId: 't2_abc123', scopeType: 'all', scopeIds: [], isActive: true, config: {}, capiEnabled: true, capiTokenSealed: require('../../src/core/utils/secretBox').seal('tok-1234567890') });
    expect(await pixels.publicPixels(workspace.id)).toEqual([]);
    expect(await pixels.serverPixelsFor(workspace.id, { funnelId: null, productIds: [] })).toEqual([]);
  });

  it('on: offered with their checks; browser tags get their event names; server sends stay in sandbox', async () => {
    env.storeFeatures.push('extra_pixels');
    const { workspace, H, base } = await store();
    const list = await request(app).get(base).set(H);
    expect(list.body.platforms).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'reddit', capi: true, serverMode: 'sandbox' }), expect.objectContaining({ name: 'taboola', capi: false })]));

    expect((await request(app).post(base).set(H).send({ platform: 'pinterest', pixelId: '2612345678901', capiEnabled: true, capiToken: 'pina_token_123456' })).status).toBe(422);
    expect((await request(app).post(base).set(H).send({ platform: 'x', pixelId: 'o1abc', capiEnabled: true, capiToken: 'not-four-keys' })).status).toBe(422);

    const reddit = await request(app).post(base).set(H).send({ platform: 'reddit', pixelId: 't2_abc123', capiEnabled: true, capiToken: 'reddit-token-123456' });
    expect(reddit.status).toBe(201);
    expect(reddit.body.pixel).toMatchObject({ capiEnabled: true, serverMode: 'sandbox' });
    expect((await request(app).post(base).set(H).send({ platform: 'taboola', pixelId: '1234567' })).status).toBe(201);

    const shown = await pixels.publicPixels(workspace.id);
    expect(shown.find((p) => p.platform === 'taboola').events).toMatchObject({ purchase: 'make_purchase' });
    expect(shown.find((p) => p.platform === 'reddit').events).toMatchObject({ purchase: 'Purchase' });
    expect((await pixels.serverPixelsFor(workspace.id, { funnelId: null, productIds: [] })).map((t) => t.pixel.platform)).toEqual(['reddit']);

    // Sandbox: built and checked, never sent.
    const out = await require('../../src/modules/marketing/pixelProviders/redditCapi').call('t2_abc123', 'reddit-token-123456', { events: [{ event_at: new Date().toISOString(), event_type: { tracking_type: 'Purchase' }, user: {}, event_metadata: { conversion_id: 'e-1' } }] });
    expect(out).toMatchObject({ sandbox: true });
  });
});
