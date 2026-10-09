'use strict';

// The store's blog (modules/blog, STORE_FEATURES blog).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const sitemapPaths = async (workspaceId) => (await request(app).get(`/api/v1/store/${workspaceId}/sitemap`)).body.entries.map((e) => e.path);

describe('blog', () => {
  it('off: no routes, and the sitemap lists no post', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/blog/posts`).set('Authorization', `Bearer ${auth.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await request(app).get(`/api/v1/store/${workspace.id}/blog/posts`)).status).toBe(404);

    await db.BlogPost.create({ workspaceId: workspace.id, title: 'Old', slug: 'old', status: 'published', publishedAt: new Date(Date.now() - 1000) });
    expect(await sitemapPaths(workspace.id)).not.toContain('/blog/old');
  });

  it('on: categories and posts; drafts and scheduled posts stay private; product blocks show the product now', async () => {
    env.storeFeatures.push('blog');
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}/blog`;
    const store = `/api/v1/store/${workspace.id}/blog`;

    const category = (await request(app).post(`${base}/categories`).set(H).send({ name: 'Style Tips' })).body.category;
    expect(category.slug).toBe('style-tips');

    const bad = await request(app).post(`${base}/posts`).set(H).send({ title: 'Bad', blocks: [{ type: 'image', url: 'http://insecure.example/x.png' }] });
    expect(bad.status).toBe(422);

    const blocks = [{ type: 'heading', text: 'Why linen' }, { type: 'paragraph', text: 'Light and cool.' }, { type: 'product', productId: product.id }];
    const live = await request(app).post(`${base}/posts`).set(H).send({ title: 'Summer Linen', categoryId: category.id, blocks, tags: ['summer'], status: 'published' });
    expect(live.status).toBe(201);
    expect(live.body.post).toMatchObject({ slug: 'summer-linen', state: 'published' });
    const draft = await request(app).post(`${base}/posts`).set(H).send({ title: 'Summer Linen' });
    expect(draft.body.post).toMatchObject({ slug: 'summer-linen-2', state: 'draft' });
    const scheduled = await request(app).post(`${base}/posts`).set(H).send({ title: 'Autumn', status: 'published', publishedAt: new Date(Date.now() + 86400e3).toISOString() });
    expect(scheduled.body.post.state).toBe('scheduled');

    const list = await request(app).get(`${store}/posts`);
    expect(list.body.posts.map((p) => p.slug)).toEqual(['summer-linen']);
    expect((await request(app).get(`${store}/posts`).query({ category: 'style-tips', tag: 'summer' })).body.total).toBe(1);
    expect((await request(app).get(`${store}/posts/summer-linen-2`)).status).toBe(404);

    const post = await request(app).get(`${store}/posts/summer-linen`);
    expect(post.status).toBe(200);
    const productBlock = post.body.post.blocks.find((b) => b.type === 'product');
    expect(productBlock.product).toMatchObject({ name: product.name, slug: product.slug });

    expect(await sitemapPaths(workspace.id)).toEqual(expect.arrayContaining(['/blog', '/blog/summer-linen']));
    expect(await sitemapPaths(workspace.id)).not.toContain('/blog/autumn');
  });
});
