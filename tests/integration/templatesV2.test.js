'use strict';

// Migration 123: version 2 of the five seeded website templates, published as
// data. Starts from a database with the v1 templates only (as production has
// them) and a site already made from v1.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const seeder = require('../../src/db/seeders/20260103000000-website-templates');
const migration = require('../../src/db/migrations/123-add-templates-v2');
const { validatePageTree } = require('../../src/modules/pages/pageTree');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const qi = () => db.sequelize.getQueryInterface();

/** The five templates with their v1 only. */
async function v1Only() {
  await seeder.up(qi(), db.Sequelize);
  await migration.down(qi());
}

describe('templates v2 (migration 123)', () => {
  it('adds a v2 per template that the gallery offers, leaving sites made from v1 as they were', async () => {
    await v1Only();
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'V1 Store');
    const minimalV1 = await db.TemplateVersion.findOne({ where: { templateId: migration.TEMPLATE_IDS.minimal, version: 1 } });
    const oldSite = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Old Site', templateVersionId: minimalV1.id });
    expect(oldSite.status).toBe(201);
    const oldPages = await db.WebsitePage.findAll({ where: { websiteId: oldSite.body.website.id }, order: [['path', 'ASC']] });

    await migration.up(qi());

    const gallery = await request(app).get('/api/v1/templates');
    expect(gallery.status).toBe(200);
    const byId = new Map(gallery.body.templates.map((t) => [t.id, t]));
    const templates = migration.loadTemplates();
    const colours = new Set();
    for (const [key, template] of Object.entries(templates)) {
      const card = byId.get(migration.TEMPLATE_IDS[key]);
      expect(card.templateVersionId).toBe(migration.V2_IDS[key]);
      expect(card.primaryColor).toBe(template.primaryColor);
      colours.add(template.primaryColor);
    }
    // Five different accents, not five blues.
    expect(colours.size).toBe(5);

    // The v1 site still has its pages exactly, and still points at v1.
    const site = await db.Website.findByPk(oldSite.body.website.id);
    expect(site.sourceTemplateVersionId).toBe(minimalV1.id);
    const pagesNow = await db.WebsitePage.findAll({ where: { websiteId: site.id }, order: [['path', 'ASC']] });
    expect(pagesNow.map((p) => [p.path, p.draftData])).toEqual(oldPages.map((p) => [p.path, p.draftData]));
    // v1 itself is still there and active.
    expect((await db.TemplateVersion.findByPk(minimalV1.id)).isActive).toBe(true);
  });

  it('ships valid page trees with section settings, several pages and no font or mode', async () => {
    await v1Only();
    await migration.up(qi());
    const templates = migration.loadTemplates();
    for (const [key] of Object.entries(templates)) {
      const version = await db.TemplateVersion.findByPk(migration.V2_IDS[key]);
      expect(version.version).toBe(2);
      expect(Object.keys(version.globalStyles)).toEqual(['primaryColor']);
      expect(version.pages.length).toBeGreaterThanOrEqual(2);
      expect(version.pages.filter((p) => p.path === '/')).toHaveLength(1);
      for (const page of version.pages) {
        expect(() => validatePageTree(page.builderData, { label: `${key} ${page.path}` })).not.toThrow();
        // No page on a path the storefront keeps for itself.
        expect(['f', 'cart', 'checkout', 'products', 'orders', 'offer', 'track', 'preview', 'pay']).not.toContain(page.path.split('/')[1]);
      }
      const home = version.pages.find((p) => p.path === '/').builderData.sections;
      expect(home.length).toBeGreaterThanOrEqual(5);
      expect(home.some((s) => s.settings && (s.settings.background || s.settings.width || s.settings.padding))).toBe(true);
      // No image sources or placeholder pictures shipped with a template.
      expect(JSON.stringify(version.pages)).not.toMatch(/https?:\/\/[^"]*\.(png|jpe?g|webp|svg)/i);
    }
    // Each template has a structure of its own.
    const signatures = new Set();
    for (const key of Object.keys(templates)) {
      const version = await db.TemplateVersion.findByPk(migration.V2_IDS[key]);
      const home = version.pages.find((p) => p.path === '/').builderData.sections;
      signatures.add(home.map((s) => s.id.replace(/-[^-]+$/, '')).join(','));
    }
    expect(signatures.size).toBe(5);
  });

  it('builds a new site from v2 with all its pages', async () => {
    await v1Only();
    await migration.up(qi());
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'V2 Store');
    const res = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Fashion Site', templateVersionId: migration.V2_IDS.fashion });
    expect(res.status).toBe(201);
    expect(res.body.pages.map((p) => p.path).sort()).toEqual(['/', '/shipping', '/size-guide']);
    expect(res.body.website.globalStyles).toEqual({ primaryColor: migration.loadTemplates().fashion.primaryColor });
  });

  it("keeps an accent a platform admin set, and runs twice without a second copy", async () => {
    await v1Only();
    await db.Template.update({ primaryColor: '#123456' }, { where: { id: migration.TEMPLATE_IDS.food } });
    await migration.up(qi());
    await migration.up(qi());
    expect((await db.Template.findByPk(migration.TEMPLATE_IDS.food)).primaryColor).toBe('#123456');
    expect(await db.TemplateVersion.count({ where: { templateId: migration.TEMPLATE_IDS.food } })).toBe(2);

    // Down puts the v1 swatch back where v2 had set it, and removes v2.
    await migration.down(qi());
    expect((await db.Template.findByPk(migration.TEMPLATE_IDS.minimal)).primaryColor).toBe(migration.V1_COLORS.minimal);
    expect(await db.TemplateVersion.count({ where: { id: Object.values(migration.V2_IDS) } })).toBe(0);
  });

  it('does nothing on a database without the templates', async () => {
    await migration.up(qi());
    expect(await db.TemplateVersion.count({ where: { id: Object.values(migration.V2_IDS) } })).toBe(0);
  });
});
