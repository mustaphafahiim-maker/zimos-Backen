'use strict';

/**
 * What the `anthropic` provider asks the model for, per feature: the JSON
 * schema the answer must follow (structured outputs), how hard the model
 * thinks (`effort`), the token ceiling, the language to write in, and the
 * clean-up applied to the answer before the AI module validates it.
 *
 * The schemas mirror the `output` schemas in ../features.js and
 * ../featuresP2.js and the shapes the sandbox answers with. Structured
 * outputs need every object closed (`additionalProperties: false`) and do
 * not take length or number limits, so limits are enums where they matter
 * and `clamp` trims what a schema cannot.
 *
 * Page trees (`page`, `store_builder`) use a narrow set of element types with
 * fixed props — the ones the sandbox uses — instead of every type the page
 * validator allows. That keeps the tree valid by construction and leaves out
 * `testimonial`, `countdown` and `stars_display`, which a generator could only
 * fill with invented reviews or fake urgency (SPEC §21).
 */

const LANGUAGE = {
  egyptian: 'Egyptian Arabic (the colloquial dialect people in Egypt write online, in Arabic script)',
  gulf: 'Gulf Arabic (in Arabic script)',
  msa: 'Modern Standard Arabic',
  english: 'English',
  french: 'French',
};
const language = (dialect) => LANGUAGE[dialect] || LANGUAGE.egyptian;

// --- schema helpers (structured outputs: every property required, objects closed)

const str = { type: 'string' };
const bool = { type: 'boolean' };
const arr = (items) => ({ type: 'array', items });
const oneOf = (values) => ({ type: typeof values[0] === 'number' ? 'integer' : 'string', enum: values });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// --- clean-up helpers ---------------------------------------------------------

const clamp = (value, max) => String(value == null ? '' : value).trim().slice(0, max).trim();
const firstN = (list, n) => (Array.isArray(list) ? list.slice(0, n) : []);

function slugify(value, fallback) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
  return slug || fallback;
}

// --- page trees -----------------------------------------------------------------

/** A section → row → column → element tree whose elements are one of `variants` ([type, propsSchema]). */
function treeSchema(variants) {
  const element = { anyOf: variants.map(([type, props]) => obj({ id: str, type: oneOf([type]), props: obj(props) })) };
  const column = obj({ id: str, type: oneOf(['column']), span: oneOf([12, 6, 4, 3]), elements: arr(element) });
  const row = obj({ id: str, type: oneOf(['row']), columns: arr(column) });
  const section = obj({ id: str, type: oneOf(['section']), rows: arr(row) });
  return obj({ version: oneOf([1]), sections: arr(section) });
}

/**
 * Fresh ids (unique by construction; the model's own are not trusted to be),
 * elements passed through `fixElement` (return null to drop one), empty
 * columns, rows and sections removed.
 */
function cleanTree(tree, fixElement) {
  let n = 0;
  const id = (prefix) => `${prefix}-${++n}`;
  const sections = [];
  for (const section of (tree && tree.sections) || []) {
    const rows = [];
    for (const row of section.rows || []) {
      const columns = [];
      for (const column of row.columns || []) {
        const elements = [];
        for (const el of column.elements || []) {
          const props = fixElement(el.type, { ...(el.props || {}) });
          if (props) elements.push({ id: id('e'), type: el.type, props });
        }
        if (elements.length) columns.push({ id: id('c'), type: 'column', span: column.span || 12, elements });
      }
      if (columns.length) rows.push({ id: id('r'), type: 'row', columns });
    }
    if (rows.length) sections.push({ id: id('s'), type: 'section', rows });
  }
  return { version: 1, sections };
}

const qa = obj({ q: str, a: str });

// --- the features ---------------------------------------------------------------

const FEATURES = {
  product: {
    effort: 'medium',
    maxTokens: 12000,
    language: ({ input }) => language(input.dialect),
    schema: () =>
      obj({
        name: str,
        description: str,
        features: arr(obj({ title: str, description: str })),
        faqs: arr(obj({ question: str, answer: str })),
        metaDescription: str,
        slug: str,
        specialOfferText: str,
      }),
    finish: (out, { input }) => ({
      name: clamp(out.name, 200) || clamp(input.name, 200),
      description: clamp(out.description, 5000),
      features: firstN(out.features, 12).map((f) => ({ title: clamp(f.title, 120), description: clamp(f.description, 600) })).filter((f) => f.title),
      faqs: firstN(out.faqs, 20).map((f) => ({ question: clamp(f.question, 200), answer: clamp(f.answer, 1500) })).filter((f) => f.question && f.answer),
      metaDescription: clamp(out.metaDescription, 160),
      slug: slugify(out.slug, 'product'),
      specialOfferText: clamp(out.specialOfferText, 200),
    }),
  },

  page: {
    effort: 'medium',
    maxTokens: 16000,
    language: ({ input }) => language(input.dialect),
    note: 'The response schema lists the element types you may use for this page; it is narrower than the list in the task, so use only the schema\'s.',
    schema: ({ context }) => {
      const p = context.product;
      const variants = [
        ['heading', { text: str, level: oneOf([1, 2, 3]) }],
        ['text', { text: str }],
        ['button', { label: str, href: oneOf([`/products/${p.slug}`]) }],
        ['list', { items: arr(str) }],
        ['faq', { items: arr(qa) }],
        ['product_card', { productId: oneOf([p.id]), showPrice: bool, showBuyButton: bool }],
      ];
      // A picture only when the product has one: the model never makes up an address.
      if (p.imageUrl) variants.splice(2, 0, ['image', { src: oneOf([p.imageUrl]), alt: str }]);
      return obj({ title: str, tree: treeSchema(variants) });
    },
    finish: (out, { context }) => {
      const p = context.product;
      const tree = cleanTree(out.tree, (type, props) => {
        if (type === 'image') return p.imageUrl ? { src: p.imageUrl, alt: clamp(props.alt, 300) || p.name } : null;
        if (type === 'button') return { label: clamp(props.label, 100), href: `/products/${p.slug}` };
        if (type === 'product_card') return { productId: p.id, showPrice: props.showPrice !== false, showBuyButton: props.showBuyButton !== false };
        if (type === 'list') return { items: firstN(props.items, 20).map((i) => clamp(i, 300)).filter(Boolean) };
        if (type === 'faq') return { items: firstN(props.items, 20).map((i) => ({ q: clamp(i.q, 200), a: clamp(i.a, 1500) })).filter((i) => i.q && i.a) };
        return props;
      });
      return { title: clamp(out.title, 200) || p.name, tree };
    },
  },

  translate: {
    effort: 'medium',
    maxTokens: 16000,
    language: ({ input }) => language(input.targetLanguage),
    schema: ({ input }) => obj({ fields: obj(Object.fromEntries(Object.keys(input.fields).map((key) => [key, str]))) }),
    finish: (out, { input }) => ({
      fields: Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, value ? clamp(out.fields && out.fields[key], 8000) : ''])),
    }),
  },

  policies: {
    effort: 'medium',
    maxTokens: 12000,
    language: ({ input }) => language(input.dialect),
    schema: () => obj({ shipping: str, returns: str, privacy: str }),
    finish: (out) => ({ shipping: clamp(out.shipping, 6000), returns: clamp(out.returns, 6000), privacy: clamp(out.privacy, 6000) }),
  },

  page_review: {
    effort: 'medium',
    maxTokens: 10000,
    language: ({ input }) => language(input.dialect),
    note:
      'When you suggest urgency, it must be a real, dated offer the store actually runs — never a countdown that restarts, a made-up stock count or a visitor counter. Suggest showing real reviews only, never writing them.',
    schema: () =>
      obj({
        score: { type: 'integer' },
        summary: str,
        recommendations: arr(obj({ title: str, detail: str, severity: oneOf(['high', 'medium', 'low']) })),
      }),
    finish: (out) => {
      const order = { high: 0, medium: 1, low: 2 };
      return {
        score: Math.max(0, Math.min(100, Math.round(Number(out.score) || 0))),
        summary: clamp(out.summary, 1200),
        recommendations: firstN(out.recommendations, 12)
          .map((r) => ({ title: clamp(r.title, 160), detail: clamp(r.detail, 800), severity: r.severity }))
          .filter((r) => r.title)
          .sort((a, b) => order[a.severity] - order[b.severity]),
      };
    },
  },

  ad_creatives: {
    effort: 'medium',
    maxTokens: 10000,
    language: ({ input }) => language(input.dialect),
    schema: ({ context }) => {
      const images = context.product.images || [];
      return obj({
        headlines: arr(str),
        primaryTexts: arr(str),
        // Banners sit on the product's own pictures only; none when it has no pictures.
        ...(images.length
          ? { banners: arr(obj({ imageUrl: oneOf(images), headline: str, subline: str, badge: str, format: oneOf(['square', 'story', 'landscape']) })) }
          : {}),
      });
    },
    finish: (out) => ({
      headlines: firstN(out.headlines, 6).map((h) => clamp(h, 60)).filter(Boolean),
      primaryTexts: firstN(out.primaryTexts, 5).map((t) => clamp(t, 800)).filter(Boolean),
      banners: firstN(out.banners, 6)
        .map((b) => ({ imageUrl: b.imageUrl, headline: clamp(b.headline, 60), subline: clamp(b.subline, 140), badge: clamp(b.badge, 40), format: b.format }))
        .filter((b) => b.headline),
    }),
  },

  store_builder: {
    effort: 'medium',
    maxTokens: 16000,
    language: ({ input }) => language(input.dialect),
    note: 'The response schema lists the element types you may use for the home page; it is narrower than the list in the task, so use only the schema\'s.',
    schema: ({ context }) => {
      const keys = (Array.isArray(context.themes) ? context.themes : []).map((t) => t.key).filter(Boolean);
      return obj({
        theme: obj({ key: oneOf(keys.length ? keys : ['original']), primaryColor: str }),
        home: obj({
          title: str,
          tree: treeSchema([
            ['heading', { text: str, level: oneOf([1, 2, 3]) }],
            ['text', { text: str }],
            ['button', { label: str, href: oneOf(['/products']), variant: oneOf(['primary', 'secondary']) }],
            ['list', { items: arr(str) }],
            ['product_list', { title: str, source: oneOf(['newest', 'all_active']), limit: oneOf([4, 8, 12]), columns: oneOf([2, 3, 4]) }],
            ['collection_list', { title: str, limit: oneOf([3, 6, 9]), columns: oneOf([2, 3]) }],
            ['faq', { title: str, items: arr(qa) }],
          ]),
        }),
        collections: arr(obj({ name: str, description: str })),
        policies: obj({ shipping: str, returns: str, privacy: str }),
      });
    },
    finish: (out, { input }) => ({
      theme: { key: out.theme.key, primaryColor: /^#[0-9a-fA-F]{6}$/.test(out.theme.primaryColor || '') ? out.theme.primaryColor : input.color },
      home: {
        title: clamp(out.home.title, 200) || input.storeName,
        tree: cleanTree(out.home.tree, (type, props) => {
          if (type === 'list') return { items: firstN(props.items, 20).map((i) => clamp(i, 300)).filter(Boolean) };
          if (type === 'faq') return { title: clamp(props.title, 300), items: firstN(props.items, 20).map((i) => ({ q: clamp(i.q, 200), a: clamp(i.a, 1500) })).filter((i) => i.q && i.a) };
          return props;
        }),
      },
      collections: firstN(out.collections, 8).map((c) => ({ name: clamp(c.name, 120), description: clamp(c.description, 1000) })).filter((c) => c.name),
      policies: { shipping: clamp(out.policies.shipping, 6000), returns: clamp(out.policies.returns, 6000), privacy: clamp(out.policies.privacy, 6000) },
    }),
  },

  wa_reply: {
    effort: 'low',
    maxTokens: 6000,
    language: ({ context }) => language(context.dialect),
    schema: () => obj({ reply: str }),
    finish: (out) => ({ reply: clamp(out.reply, 1000) }),
  },

  // whatsapp/bot: the answer goes to the customer as is, so it is quick and short.
  support_reply: {
    effort: 'low',
    maxTokens: 6000,
    live: true,
    language: ({ input }) => language(input.dialect),
    note: 'Your text is sent to the customer as it is, with no person reviewing it first.',
    schema: () => obj({ action: oneOf(['reply', 'handoff']), text: str }),
    finish: (out) => ({ action: out.action, text: clamp(out.text, 1000) }),
  },

  // risk/aiOrderCheck: three yes/no findings about a moderate-risk order.
  order_check: {
    effort: 'low',
    maxTokens: 4000,
    language: () => null,
    schema: () => obj({ is_gibberish: bool, is_abusive: bool, address_complete: bool }),
    finish: (out) => ({ is_gibberish: out.is_gibberish === true, is_abusive: out.is_abusive === true, address_complete: out.address_complete !== false }),
  },
};

module.exports = { FEATURES, LANGUAGE };
