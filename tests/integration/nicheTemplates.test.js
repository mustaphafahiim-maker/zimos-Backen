'use strict';

// The ten niche store templates (20260104000000-niche-store-templates.js):
// every page tree they ship must be a valid Section -> Row -> Column -> Element
// tree, and once seeded they must show up on the public template picker with a
// templateVersionId the merchant can create a website from.

const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const seeder = require('../../src/db/seeders/20260104000000-niche-store-templates');
const { validatePageTree, ALLOWED_ELEMENT_TYPES } = require('../../src/modules/pages/pageTree');

const NICHE_IDS = [
  'c0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
  'c0000000-0000-4000-8000-000000000004',
  'c0000000-0000-4000-8000-000000000005',
  'c0000000-0000-4000-8000-000000000006',
  'c0000000-0000-4000-8000-000000000007',
  'c0000000-0000-4000-8000-000000000008',
  'c0000000-0000-4000-8000-000000000009',
  'c0000000-0000-4000-8000-00000000000a',
];

// Tables are truncated before every test, so each test seeds for itself.
async function seed() {
  await seeder.up(db.sequelize.getQueryInterface(), db.Sequelize);
}

const elementsOf = (tree) =>
  (tree.sections || []).flatMap((s) =>
    (s.rows || []).flatMap((r) => (r.columns || []).flatMap((c) => c.elements || []))
  );

describe('niche store templates seeder', () => {
  it('seeds ten published templates, each with one active version', async () => {
    await seed();

    const templates = await db.Template.findAll({ where: { id: NICHE_IDS } });
    expect(templates).toHaveLength(10);
    expect(templates.every((t) => t.isPublished)).toBe(true);

    const versions = await db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });
    expect(versions).toHaveLength(10);
    expect(versions.every((v) => v.isActive && v.version === 1)).toBe(true);
  });

  it('every seeded page tree passes validatePageTree (publish-strict)', async () => {
    await seed();
    const versions = await db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });

    for (const version of versions) {
      expect(Array.isArray(version.pages)).toBe(true);
      expect(version.pages.length).toBeGreaterThan(0);
      for (const page of version.pages) {
        expect(typeof page.path).toBe('string');
        expect(() =>
          validatePageTree(page.builderData, { requireContent: true, label: `template ${version.templateId} ${page.path}` })
        ).not.toThrow();
        for (const el of elementsOf(page.builderData)) {
          expect(ALLOWED_ELEMENT_TYPES.has(el.type)).toBe(true);
        }
      }
    }
  });

  it('gives each template its own non-blue primary colour', async () => {
    await seed();
    const versions = await db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });

    const colours = versions.map((v) => v.globalStyles.primaryColor);
    expect(colours.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c))).toBe(true);
    expect(new Set(colours).size).toBe(10);
    // none of the five general templates' blues
    const blues = ['#2563EB', '#1D4ED8', '#1E40AF', '#0EA5E9', '#3B82F6'];
    expect(colours.filter((c) => blues.includes(c))).toEqual([]);
  });

  it('ships no invented social proof: testimonials are empty for the merchant to fill', async () => {
    await seed();
    const versions = await db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });

    for (const version of versions) {
      for (const page of version.pages) {
        for (const el of elementsOf(page.builderData)) {
          if (el.type !== 'testimonial') continue;
          expect(el.props.quote).toBe('');
          expect(el.props.author).toBe('');
          expect(el.props.rating || 0).toBe(0);
        }
      }
    }
  });

  it('uses the immersive element types where the niche calls for them', async () => {
    await seed();
    const versions = await db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });
    const typesOf = (templateId) => {
      const v = versions.find((x) => x.templateId === templateId);
      return new Set(v.pages.flatMap((p) => elementsOf(p.builderData).map((e) => e.type)));
    };

    expect(typesOf(NICHE_IDS[1]).has('shader_hero')).toBe(true); // perfume & oud
    expect(typesOf(NICHE_IDS[2]).has('scroll_story')).toBe(true); // skincare
    expect(typesOf(NICHE_IDS[3]).has('product_3d')).toBe(true); // watches
    expect(typesOf(NICHE_IDS[4]).has('orbit_gallery')).toBe(true); // home & decor
    expect(typesOf(NICHE_IDS[9]).has('orbit_gallery')).toBe(true); // jewellery
    expect(typesOf(NICHE_IDS[9]).has('shader_hero')).toBe(true);
  });

  it('GET /api/v1/templates offers all ten with a templateVersionId', async () => {
    await seed();

    const res = await request(app).get('/api/v1/templates');
    expect(res.status).toBe(200);

    const listed = res.body.templates.filter((t) => NICHE_IDS.includes(t.id));
    expect(listed).toHaveLength(10);
    for (const item of listed) {
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.templateVersionId).toMatch(/^d0000000-0000-4000-8000-/);
    }
  });

  it('GET /api/v1/templates/:id returns a usable tree for each niche template', async () => {
    await seed();

    for (const id of NICHE_IDS) {
      const res = await request(app).get(`/api/v1/templates/${id}`);
      expect(res.status).toBe(200);
      const home = res.body.template.pages.find((p) => p.path === '/');
      expect(home.pageType).toBe('home');
      expect(() => validatePageTree(home.builderData, { requireContent: true })).not.toThrow();
    }
  });

  it("down() removes exactly the ten templates and their versions", async () => {
    await seed();
    await seeder.down(db.sequelize.getQueryInterface(), db.Sequelize);

    expect(await db.Template.count({ where: { id: NICHE_IDS } })).toBe(0);
    expect(await db.TemplateVersion.count({ where: { templateId: NICHE_IDS } })).toBe(0);
  });
});
