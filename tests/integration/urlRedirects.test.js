'use strict';

// Storefront URL redirects (modules/urlRedirects, STORE_FEATURES url_redirects).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const lookup = (workspaceId, path) => request(app).get(`/api/v1/store/${workspaceId}/redirects/lookup`).query({ path });

async function eventually(check) {
  for (let i = 0; i < 20; i += 1) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('URL redirects', () => {
  it('off: no routes, and a slug change adds no redirect', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/redirects`).set('Authorization', `Bearer ${auth.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await lookup(workspace.id, '/old')).status).toBe(404);

    await (await db.Product.findByPk(product.id)).update({ slug: `renamed-${Date.now()}` });
    await new Promise((r) => setTimeout(r, 200));
    expect(await db.UrlRedirect.count()).toBe(0);
  });

  it('on: manual redirects, no loops, lookup, import, and slug changes followed', async () => {
    env.storeFeatures.push('url_redirects');
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}/redirects`;

    expect((await request(app).post(base).set(H).send({ fromPath: '/same', toPath: '/same' })).status).toBe(422);
    const created = await request(app).post(base).set(H).send({ fromPath: '/old-page/', toPath: '/new-page' });
    expect(created.status).toBe(201);
    expect(created.body.redirect).toMatchObject({ fromPath: '/old-page', toPath: '/new-page', statusCode: 301, source: 'manual' });
    expect((await request(app).post(base).set(H).send({ fromPath: '/new-page', toPath: '/old-page' })).status).toBe(422);

    const found = await lookup(workspace.id, '/old-page?utm=x');
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ to: '/new-page', statusCode: 301 });
    expect((await lookup(workspace.id, '/nothing-here')).status).toBe(404);

    const imported = await request(app).post(`${base}/import`).set(H).send({ csv: 'from,to,code\n/a,/b,302\n/old-page,/newer\nnot a path,/x' });
    expect(imported.body).toMatchObject({ created: 1, updated: 1 });
    expect(imported.body.errors).toEqual([expect.objectContaining({ line: 4 })]);

    const oldSlug = product.slug || (await db.Product.findByPk(product.id)).slug;
    await (await db.Product.findByPk(product.id)).update({ slug: 'new-slug' });
    expect(await eventually(async () => (await db.UrlRedirect.count({ where: { workspaceId: workspace.id, source: 'auto' } })) === 1)).toBe(true);
    const auto = await db.UrlRedirect.findOne({ where: { workspaceId: workspace.id, source: 'auto' } });
    expect(auto).toMatchObject({ fromPath: `/products/${oldSlug}`, toPath: '/products/new-slug' });
  });
});
