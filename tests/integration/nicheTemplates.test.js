'use strict';

// The ten niche store templates (20260104000000-niche-store-templates.js):
// every page tree they ship must be a valid Section -> Row -> Column -> Element
// tree, lay out on the storefront's 12-column grid, use only the layout
// settings the storefront renderer honours, claim nothing on the merchant's
// behalf, and once seeded show up on the public template picker with a
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

// The pass-through layout settings the storefront renderer reads. Anything
// outside these keys/values is silently ignored on the live page, so a typo in
// a template would ship a section that looks like the default.
const ALLOWED_SETTINGS = {
  section: {
    background: ['none', 'paper', 'raised', 'primary-soft', 'primary', 'ink'],
    padding: ['compact', 'normal', 'roomy'],
    width: ['normal', 'wide', 'full'],
  },
  row: { gap: ['tight', 'normal', 'loose'] },
  column: {
    surface: ['none', 'card'],
    align: ['start', 'center'],
    verticalAlign: ['start', 'center', 'end'],
  },
};

const NEW_ELEMENT_TYPES = ['shader_hero', 'product_3d', 'orbit_gallery', 'scroll_story', 'marquee', 'comparison'];

// Tables are truncated before every test, so each test seeds for itself.
async function seed() {
  await seeder.up(db.sequelize.getQueryInterface(), db.Sequelize);
}

async function seededVersions() {
  await seed();
  return db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });
}

const sectionsOf = (tree) => tree.sections || [];
const rowsOf = (tree) => sectionsOf(tree).flatMap((s) => s.rows || []);
const columnsOf = (tree) => rowsOf(tree).flatMap((r) => r.columns || []);
const elementsOf = (tree) => columnsOf(tree).flatMap((c) => c.elements || []);

/** Every string reachable inside an element's props, however nested. */
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, out));
  return out;
}

// Jest's expect takes no message argument, so context rides inside the value:
// a failure prints `{ where, ... , ok: false }` instead of a bare `false`.
function expectOk(where, ok, extra = {}) {
  expect({ where, ...extra, ok }).toEqual({ where, ...extra, ok: true });
}

function expectAllowedSettings(node, kind, label) {
  if (node.settings === undefined) return;
  expect(typeof node.settings).toBe('object');
  for (const [key, value] of Object.entries(node.settings)) {
    const allowed = ALLOWED_SETTINGS[kind][key];
    expectOk(label, Array.isArray(allowed) && allowed.includes(value), { setting: `${kind}.${key}`, value });
  }
}

describe('niche store templates seeder', () => {
  it('seeds ten published templates, each with one active version', async () => {
    await seed();

    const templates = await db.Template.findAll({ where: { id: NICHE_IDS } });
    expect(templates).toHaveLength(10);
    expect(templates.every((t) => t.isPublished)).toBe(true);
    expect(templates.every((t) => t.thumbnailUrl === null)).toBe(true);

    const versions = await db.TemplateVersion.findAll({ where: { templateId: NICHE_IDS } });
    expect(versions).toHaveLength(10);
    expect(versions.every((v) => v.isActive && v.version === 1)).toBe(true);
  });

  it('every seeded page tree passes validatePageTree (publish-strict)', async () => {
    const versions = await seededVersions();

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

  it('lays out on the 12-column grid: every row\'s spans sum to 12, node ids are unique per page', async () => {
    const versions = await seededVersions();

    for (const version of versions) {
      for (const page of version.pages) {
        const tree = page.builderData;
        for (const row of rowsOf(tree)) {
          const spans = row.columns.map((c) => c.span);
          expect(spans.every((s) => Number.isInteger(s) && s >= 1 && s <= 12)).toBe(true);
          const sum = spans.reduce((a, b) => a + b, 0);
          expectOk(`${version.templateId} row ${row.id}`, sum === 12, { spans });
        }
        // React keys on the storefront and the editor's section selection both
        // use node ids, so a duplicate would collapse two nodes into one.
        const ids = [
          ...sectionsOf(tree).map((s) => s.id),
          ...rowsOf(tree).map((r) => r.id),
          ...columnsOf(tree).map((c) => c.id),
          ...elementsOf(tree).map((e) => e.id),
        ];
        const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
        expectOk(version.templateId, duplicates.length === 0, { duplicates });
      }
    }
  });

  it('uses only the layout settings the storefront renderer honours', async () => {
    const versions = await seededVersions();

    for (const version of versions) {
      for (const page of version.pages) {
        const tree = page.builderData;
        const label = `${version.templateId} ${page.path}`;
        sectionsOf(tree).forEach((s) => expectAllowedSettings(s, 'section', `${label} section ${s.id}`));
        rowsOf(tree).forEach((r) => expectAllowedSettings(r, 'row', `${label} row ${r.id}`));
        columnsOf(tree).forEach((c) => expectAllowedSettings(c, 'column', `${label} column ${c.id}`));
      }
    }
  });

  it('gives each template its own non-blue primary colour', async () => {
    const versions = await seededVersions();

    const colours = versions.map((v) => v.globalStyles.primaryColor);
    expect(colours.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c))).toBe(true);
    expect(new Set(colours).size).toBe(10);
    // none of the five general templates' blues
    const blues = ['#2563EB', '#1D4ED8', '#1E40AF', '#0EA5E9', '#3B82F6'];
    expect(colours.filter((c) => blues.includes(c))).toEqual([]);
  });

  it('ships no invented social proof: testimonials are empty for the merchant to fill', async () => {
    const versions = await seededVersions();

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

  it('claims nothing for the merchant: FAQ answers are instructions, no numbers, no images, no catalogue ids', async () => {
    const versions = await seededVersions();
    const INSTRUCTION = /اكتب|ارفع/;

    for (const version of versions) {
      for (const page of version.pages) {
        for (const el of elementsOf(page.builderData)) {
          const props = el.props || {};
          if (el.type === 'faq' || el.type === 'accordion') {
            expect(props.items.length).toBeGreaterThan(0);
            for (const item of props.items) expectOk(`${version.templateId} faq "${item.q}"`, INSTRUCTION.test(item.a), { a: item.a });
          }
          if (el.type === 'image') expect(props.src).toBe('');
          if (el.type === 'gallery') expect(props.images).toEqual([]);
          if (el.type === 'scroll_story') for (const step of props.steps) expect(step.image).toBe('');
          if (el.type === 'product_card' || el.type === 'product_3d') expect(props.productId).toBe('');
          if (el.type === 'product_3d') expect(props.modelUrl).toBe('');
          if (el.type === 'orbit_gallery') expect(props.collectionId).toBe('');
          if (el.type === 'comparison') {
            expect(props.rows.length).toBeGreaterThan(0);
            for (const r of props.rows) {
              expect(r.us).toMatch(INSTRUCTION);
              expect(r.them).toMatch(INSTRUCTION);
            }
          }
          // No prices, ratings, counts or delivery days anywhere in the copy —
          // those are the merchant's facts, not the template's.
          const withDigits = stringsIn(props).filter((s) => /[0-9٠-٩]/.test(s));
          expectOk(`${version.templateId} ${el.id}`, withDigits.length === 0, { withDigits });
        }
      }
    }
  });

  it('gives every template a home page of 7-10 sections built from at least three of the new types/settings', async () => {
    const versions = await seededVersions();

    for (const version of versions) {
      const home = version.pages.find((p) => p.path === '/');
      const tree = home.builderData;
      expect(sectionsOf(tree).length).toBeGreaterThanOrEqual(7);
      expect(sectionsOf(tree).length).toBeLessThanOrEqual(10);

      const features = new Set();
      for (const el of elementsOf(tree)) if (NEW_ELEMENT_TYPES.includes(el.type)) features.add(el.type);
      if (sectionsOf(tree).some((s) => s.settings)) features.add('section.settings');
      if (rowsOf(tree).some((r) => r.settings)) features.add('row.settings');
      if (columnsOf(tree).some((c) => c.settings)) features.add('column.settings');
      if (rowsOf(tree).some((r) => r.columns.length > 1)) features.add('multi-column');
      expectOk(version.templateId, features.size >= 3, { features: [...features].sort() });
    }
  });

  it('makes the ten visibly different: no two share a section-by-section layout', async () => {
    const versions = await seededVersions();

    const signature = (tree) =>
      sectionsOf(tree)
        .map((s) => (s.rows || []).map((r) => r.columns.map((c) => `${c.span}:${c.elements.map((e) => e.type).join('+')}`).join('|')).join('/'))
        .join(' > ');
    const signatures = versions.map((v) => signature(v.pages.find((p) => p.path === '/').builderData));
    expect(new Set(signatures).size).toBe(10);
  });

  it('uses the immersive element types where the niche calls for them', async () => {
    const versions = await seededVersions();
    const typesOf = (templateId) => {
      const v = versions.find((x) => x.templateId === templateId);
      return new Set(v.pages.flatMap((p) => elementsOf(p.builderData).map((e) => e.type)));
    };

    expect(typesOf(NICHE_IDS[1]).has('shader_hero')).toBe(true); // perfume & oud
    expect(typesOf(NICHE_IDS[1]).has('scroll_story')).toBe(true);
    expect(typesOf(NICHE_IDS[1]).has('comparison')).toBe(true);
    expect(typesOf(NICHE_IDS[2]).has('scroll_story')).toBe(true); // skincare
    expect(typesOf(NICHE_IDS[3]).has('product_3d')).toBe(true); // watches
    expect(typesOf(NICHE_IDS[3]).has('comparison')).toBe(true);
    expect(typesOf(NICHE_IDS[4]).has('orbit_gallery')).toBe(true); // home & decor
    expect(typesOf(NICHE_IDS[6]).has('countdown')).toBe(true); // supplements
    expect(typesOf(NICHE_IDS[7]).has('product_3d')).toBe(true); // phone accessories
    expect(typesOf(NICHE_IDS[7]).has('comparison')).toBe(true);
    expect(typesOf(NICHE_IDS[8]).has('scroll_story')).toBe(true); // coffee
    expect(typesOf(NICHE_IDS[8]).has('marquee')).toBe(true);
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
