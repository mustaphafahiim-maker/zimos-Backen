'use strict';

/**
 * Ten niche store templates for the Egyptian market, offered on the same
 * merchant "pick a template" screen as the five general ones
 * (20260103000000-website-templates.js). Same shape: one active version per
 * template whose `pages` array holds a real home page, deep-copied into the
 * merchant's website when they choose it.
 *
 * Each template has its own art direction — they are ten different stores,
 * not ten variations of one layout. The differences are carried by the page
 * tree itself, in the three things the storefront renderer honours:
 *
 *  - layout: multi-column rows (spans sum to 12), rendered as a 12-col grid;
 *  - settings: `section.settings` {background, padding, width},
 *    `row.settings` {gap}, `column.settings` {surface, align, verticalAlign};
 *  - element types: the immersive/storefront ones (shader_hero, product_3d,
 *    orbit_gallery, scroll_story, marquee, comparison) next to the originals.
 *
 * Two rules the copy follows:
 *  - Every template gets a `primaryColor` that suits its niche, so the picker
 *    is not ten shades of the platform blue.
 *  - Nothing is claimed on the merchant's behalf. Wherever a real business
 *    fact would go the copy is an instruction ("اكتب هنا…"): testimonials
 *    ship empty, FAQ answers are placeholders, no prices, numbers, delivery
 *    promises or image URLs — the storefront hides empty images.
 */

// Fixed ids so `down` is exact and re-running is predictable. `c…`/`d…` here,
// so there is no collision with the `a…`/`b…` ids of the first five.
const T = {
  modest: 'c0000000-0000-4000-8000-000000000001',
  perfume: 'c0000000-0000-4000-8000-000000000002',
  skincare: 'c0000000-0000-4000-8000-000000000003',
  watches: 'c0000000-0000-4000-8000-000000000004',
  decor: 'c0000000-0000-4000-8000-000000000005',
  kids: 'c0000000-0000-4000-8000-000000000006',
  supplements: 'c0000000-0000-4000-8000-000000000007',
  phoneAccessories: 'c0000000-0000-4000-8000-000000000008',
  coffee: 'c0000000-0000-4000-8000-000000000009',
  jewellery: 'c0000000-0000-4000-8000-00000000000a',
};
const V = {
  modest: 'd0000000-0000-4000-8000-000000000001',
  perfume: 'd0000000-0000-4000-8000-000000000002',
  skincare: 'd0000000-0000-4000-8000-000000000003',
  watches: 'd0000000-0000-4000-8000-000000000004',
  decor: 'd0000000-0000-4000-8000-000000000005',
  kids: 'd0000000-0000-4000-8000-000000000006',
  supplements: 'd0000000-0000-4000-8000-000000000007',
  phoneAccessories: 'd0000000-0000-4000-8000-000000000008',
  coffee: 'd0000000-0000-4000-8000-000000000009',
  jewellery: 'd0000000-0000-4000-8000-00000000000a',
};

// --- tiny page-tree builders (shape enforced by pages/pageTree.js) ---------
// `settings` on a section/row/column is a pass-through object the storefront
// reads defensively; it is only written when there is something in it, so a
// node the template leaves at the default keeps the settings-free shape.
const withSettings = (node, settings) =>
  settings && Object.keys(settings).length ? { ...node, settings } : node;

const el = (id, type, props = {}) => ({ id, type, props });
const column = (id, elements, span = 12, settings) =>
  withSettings({ id, type: 'column', span, elements }, settings);
const row = (id, columns, settings) => withSettings({ id, type: 'row', columns }, settings);
const section = (id, rows, settings) => withSettings({ id, type: 'section', rows }, settings);

// One full-width column. `settings.section` / `settings.column` split the
// pass-through objects so a centred CTA band reads as one call.
const oneCol = (id, elements, { section: s, column: c } = {}) =>
  section(id, [row(`${id}-r`, [column(`${id}-c`, elements, 12, c)])], s);

// Two columns side by side. `spans` must sum to 12.
const twoCol = (id, left, right, { spans = [6, 6], section: s, row: r, left: lc, right: rc } = {}) =>
  section(
    id,
    [row(`${id}-r`, [column(`${id}-a`, left, spans[0], lc), column(`${id}-b`, right, spans[1], rc)], r)],
    s
  );

// A row of equal cards (3 or 4 across), each `{icon?, title, body}`.
const cardRow = (id, cards, { section: s, gap = 'normal', level = 4 } = {}) => {
  const span = 12 / cards.length;
  return section(
    id,
    [
      row(
        `${id}-r`,
        cards.map((card, i) =>
          column(
            `${id}-c${i + 1}`,
            [
              ...(card.icon ? [el(`${id}-c${i + 1}-i`, 'icon', { name: card.icon, size: 36 })] : []),
              el(`${id}-c${i + 1}-h`, 'heading', { text: card.title, level }),
              el(`${id}-c${i + 1}-p`, 'text', { text: card.body }),
            ],
            span,
            { surface: 'card', align: 'center' }
          )
        ),
        { gap }
      ),
    ],
    s
  );
};

// --- element shorthands ------------------------------------------------------
const h = (id, text, level = 2) => el(id, 'heading', { text, level });
const p = (id, text) => el(id, 'text', { text });
const btn = (id, label, variant = 'primary', href = '/products') => el(id, 'button', { label, href, variant });
// Image src is always empty here — the merchant uploads their own and the
// storefront hides an image with no src, so nothing broken ever shows.
const img = (id, alt) => el(id, 'image', { src: '', alt, href: '' });
const productList = (id, title, columns = 4, limit = 8) =>
  el(id, 'product_list', { title, source: 'newest', limit, columns });
const productCard = (id, title) => el(id, 'product_card', { title, productId: '', showPrice: true, showBuyButton: true });
const collections = (id, title, columns = 3, limit = 6) => el(id, 'collection_list', { title, limit, columns });
const gallery = (id, title, columns = 3) => el(id, 'gallery', { title, images: [], columns });
const list = (id, title, items) => el(id, 'list', { title, items });
const faq = (id, items) => el(id, 'faq', { title: 'الأسئلة الشائعة', items });
// Ships empty on purpose: the merchant pastes a real customer's words here.
const testimonial = (id) => el(id, 'testimonial', { quote: '', author: '', rating: 0 });
const countdown = (id, label, endsInHours = 48) => el(id, 'countdown', { label, endsInHours });
const map = (id, address) => el(id, 'map', { address });

// --- immersive / storefront sections ---------------------------------------
const shaderHero = (id, title, subtitle, ctaLabel, height = 560) =>
  el(id, 'shader_hero', { title, subtitle, ctaLabel, ctaHref: '/products', height });
// `productId` empty -> the storefront shows the merchant's first product, and
// `modelUrl` empty -> it uses the product's own GLB. No model, no block.
const product3d = (id, title) => el(id, 'product_3d', { title, productId: '', modelUrl: '' });
const orbit = (id, title, limit = 8) => el(id, 'orbit_gallery', { title, limit, collectionId: '' });
// Step images left empty for the merchant to upload their own.
const scrollStory = (id, title, steps) =>
  el(id, 'scroll_story', { title, steps: steps.map(([title, body]) => ({ title, body, image: '' })) });
const marquee = (id, items, { speed = 'normal', tone = 'line' } = {}) => el(id, 'marquee', { items, speed, tone });
const comparison = (id, title, usLabel, themLabel, rows) =>
  el(id, 'comparison', { title, usLabel, themLabel, rows: rows.map(([label, us, them]) => ({ label, us, them })) });

const homePage = (sections) => ({
  path: '/',
  title: 'الرئيسية',
  pageType: 'home',
  builderData: { version: 1, sections },
  seo: {},
});

const styles = (primaryColor) => ({
  primaryColor,
  fontFamily: 'Cairo, system-ui, -apple-system, sans-serif',
  mode: 'light',
});

// Placeholder answers — the merchant replaces them with their real policy.
const RETURNS_Q = { q: 'هل يمكن استبدال أو استرجاع المنتج؟', a: 'اكتب هنا سياسة الاسترجاع والاستبدال بتاعتك.' };
const SHIPPING_Q = { q: 'إزاي بيتم الشحن؟', a: 'اكتب هنا مناطق الشحن ومواعيده والأسعار من عندك.' };
const PAYMENT_Q = { q: 'وسائل الدفع المتاحة إيه؟', a: 'اكتب هنا وسائل الدفع اللي بتقبلها في متجرك.' };

// FAQ beside an empty testimonial card — the closing pair most templates share.
const faqAndVoice = (id, items, sectionSettings) =>
  twoCol(id, [faq(`${id}-faq`, items)], [testimonial(`${id}-t`)], {
    spans: [7, 5],
    section: sectionSettings,
    right: { surface: 'card', verticalAlign: 'start' },
  });

const TEMPLATES = [
  // 1. Editorial: whitespace, an asymmetric lookbook opening, image-with-text,
  //    thin hairline strip. Muted plum.
  {
    id: T.modest,
    versionId: V.modest,
    name: 'عبايات وأزياء محتشمة',
    category: 'modest_fashion',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#6B3550'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [
            h('hero-h', 'اكتبي هنا اسم تشكيلة الموسم', 1),
            p('hero-p', 'اكتبي هنا جملة قصيرة عن روح التشكيلة: القصّة، الخامة، والمناسبة اللي اتصممت لها.'),
            btn('hero-btn', 'تسوّقي التشكيلة', 'outline'),
          ],
          [img('hero-img', 'صورة اللوك الرئيسي — ارفعيها هنا')],
          {
            spans: [5, 7],
            section: { padding: 'roomy', width: 'wide' },
            row: { gap: 'loose' },
            left: { verticalAlign: 'center' },
          }
        ),
        oneCol(
          'strip',
          [marquee('strip-m', ['اكتبي هنا خامة قطعك', 'اكتبي هنا المقاسات المتاحة', 'اكتبي هنا ما يميّز خياطتك'], { speed: 'slow' })],
          { section: { background: 'paper', padding: 'compact', width: 'full' } }
        ),
        oneCol('styles', [collections('styles-e', 'تسوّقي حسب الستايل', 3)], { section: { padding: 'roomy' } }),
        oneCol('lookbook', [h('lookbook-h', 'لوك بوك', 2), gallery('lookbook-g', '', 4)], {
          section: { padding: 'roomy', width: 'full' },
          column: { align: 'center' },
        }),
        twoCol(
          'story',
          [img('story-img', 'صورة من الورشة أو جلسة التصوير — ارفعيها هنا')],
          [
            h('story-h', 'حكاية العلامة', 2),
            p('story-p', 'اكتبي هنا إزاي بدأتي، وإيه اللي بتدوّري عليه في كل قطعة بتصمّميها.'),
            btn('story-btn', 'اعرفي أكتر', 'outline'),
          ],
          {
            section: { background: 'paper', padding: 'roomy' },
            row: { gap: 'loose' },
            right: { verticalAlign: 'center' },
          }
        ),
        oneCol('new', [productList('new-e', 'وصل حديثًا', 4)], { section: { padding: 'roomy' } }),
        twoCol(
          'fit',
          [
            list('fit-l', 'دليل المقاسات', [
              'اكتبي هنا إزاي العميلة تاخد مقاسها',
              'اكتبي هنا الفرق بين المقاسات اللي بتقدّميها',
              'اكتبي هنا نصيحة لاختيار الطول المناسب',
            ]),
          ],
          [faq('fit-faq', [{ q: 'إزاي أختار المقاس المناسب؟', a: 'اكتبي هنا جدول المقاسات وطريقة القياس بتاعتك.' }, RETURNS_Q])],
          { left: { surface: 'card' } }
        ),
        oneCol('voice', [testimonial('voice-t')], {
          section: { padding: 'roomy' },
          column: { surface: 'card', align: 'center' },
        }),
        oneCol('follow', [h('follow-h', 'تابعينا', 3), p('follow-p', 'اكتبي هنا حساباتك وفين العميلة تلاقي اللوكات الجديدة أول بأول.'), el('follow-s', 'social_icons', { links: [] })], {
          section: { background: 'paper', padding: 'compact' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 2. Dark luxury: ink screens, a shader hero, the oil-to-bottle story, a
  //    comparison table. Gold-ish accent on the dark.
  {
    id: T.perfume,
    versionId: V.perfume,
    name: 'عطور وعود',
    category: 'perfume',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#C39A4B'),
    pages: [
      homePage([
        oneCol('hero', [shaderHero('hero-e', 'عطر يفضل معاك', 'اكتب هنا حكاية علامتك في سطر واحد.', 'اكتشف العطور', 640)], {
          section: { background: 'ink', padding: 'compact', width: 'full' },
        }),
        oneCol(
          'notes',
          [marquee('notes-m', ['اكتب هنا النوتة الأولى', 'اكتب هنا النوتة الثانية', 'اكتب هنا نوتة القاعدة', 'اكتب هنا نوع العطر'], { speed: 'slow', tone: 'primary' })],
          { section: { background: 'ink', padding: 'compact', width: 'full' } }
        ),
        oneCol('families', [collections('families-e', 'عود، مسك، وعطور شرقية — اكتب أقسامك', 3)], { section: { padding: 'roomy' } }),
        oneCol(
          'story',
          [
            scrollStory('story-e', 'من الزيت للزجاجة', [
              ['اختيار الزيوت', 'اكتب هنا إزاي بتختار زيوتك ومن فين.'],
              ['التركيب', 'اكتب هنا إزاي بتوازن بين النوتات.'],
              ['التعتيق', 'اكتب هنا مدة التعتيق وطريقتها.'],
              ['التعبئة', 'اكتب هنا تفاصيل الزجاجة والتغليف.'],
            ]),
          ],
          { section: { background: 'ink', padding: 'roomy', width: 'wide' } }
        ),
        oneCol('signature', [productCard('signature-e', 'عطر الموسم')], { section: { background: 'raised', padding: 'roomy' } }),
        oneCol('all', [productList('all-e', 'كل العطور', 4)], { section: { padding: 'roomy' } }),
        oneCol(
          'why',
          [
            comparison('why-e', 'ليه تختار عطورنا', 'اكتب هنا اسم متجرك', 'عطور أخرى', [
              ['التركيز', 'اكتب هنا تركيز عطورك', 'اكتب هنا وجه المقارنة'],
              ['مصدر الزيوت', 'اكتب هنا مصدر زيوتك', 'اكتب هنا وجه المقارنة'],
              ['الثبات', 'اكتب هنا اللي بتقدر تقوله عن الثبات', 'اكتب هنا وجه المقارنة'],
              ['التغليف', 'اكتب هنا تفاصيل تغليفك', 'اكتب هنا وجه المقارنة'],
            ]),
          ],
          { section: { background: 'primary-soft', padding: 'roomy' } }
        ),
        faqAndVoice('faq', [{ q: 'العطر بيفضل قد إيه؟', a: 'اكتب هنا تفاصيل الثبات والتركيز لكل منتج.' }, RETURNS_Q], { padding: 'roomy' }),
        oneCol('cta', [h('cta-h', 'جرّب قبل ما تشتري الزجاجة الكاملة', 2), p('cta-p', 'اكتب هنا تفاصيل عرض العيّنات أو مجموعة الاكتشاف.'), btn('cta-btn', 'اطلب عيّنات')], {
          section: { background: 'primary', padding: 'roomy' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 3. Clean clinical: paper backgrounds, a three-step routine in cards, a
  //    before/after story, ingredient lists side by side. Soft sage green.
  {
    id: T.skincare,
    versionId: V.skincare,
    name: 'العناية بالبشرة',
    category: 'skincare',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#5B8C6B'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [
            h('hero-h', 'روتين بسيط لبشرتك', 1),
            p('hero-p', 'اكتب هنا اللي يميّز منتجاتك: المكوّنات، الفلسفة، ولمين اتعملت.'),
            btn('hero-btn', 'ابدأ الروتين'),
          ],
          [img('hero-img', 'صورة المنتج على خلفية هادية — ارفعها هنا')],
          {
            spans: [5, 7],
            section: { background: 'paper', padding: 'roomy', width: 'wide' },
            left: { verticalAlign: 'center' },
          }
        ),
        oneCol('claims', [marquee('claims-m', ['اكتب هنا المكوّن الرئيسي', 'اكتب هنا نوع البشرة المناسب', 'اكتب هنا اللي المنتج خالي منه'])], {
          section: { padding: 'compact', width: 'full' },
        }),
        cardRow(
          'routine',
          [
            { icon: 'check', title: 'الخطوة الأولى — التنظيف', body: 'اكتب هنا المنتج وطريقة الاستخدام.' },
            { icon: 'heart', title: 'الخطوة الثانية — الترطيب', body: 'اكتب هنا المنتج وطريقة الاستخدام.' },
            { icon: 'shield', title: 'الخطوة الثالثة — الحماية', body: 'اكتب هنا المنتج وطريقة الاستخدام.' },
          ],
          { section: { padding: 'roomy' }, gap: 'loose' }
        ),
        oneCol(
          'results',
          [
            scrollStory('results-e', 'قبل وبعد', [
              ['البداية', 'ارفع هنا صورة حقيقية بعد إذن العميلة، واكتب حالة البشرة قبل الروتين.'],
              ['أثناء الروتين', 'اكتب هنا إيه اللي اتغيّر مع الاستمرار.'],
              ['النتيجة', 'ارفع هنا الصورة الأخيرة واكتب ملاحظة العميلة بكلماتها.'],
            ]),
          ],
          { section: { background: 'primary-soft', padding: 'roomy', width: 'wide' } }
        ),
        oneCol('products', [productList('products-e', 'منتجات الروتين', 3, 6)], { section: { padding: 'roomy' } }),
        twoCol(
          'ingredients',
          [list('ingredients-in', 'المكوّنات اللي بنعتمد عليها', ['اكتب هنا مكوّن وفايدته', 'اكتب هنا مكوّن وفايدته', 'اكتب هنا مكوّن وفايدته'])],
          [list('ingredients-out', 'المكوّنات اللي بنتجنّبها', ['اكتب هنا مكوّن بتتجنّبه وليه', 'اكتب هنا مكوّن بتتجنّبه وليه', 'اكتب هنا مكوّن بتتجنّبه وليه'])],
          { section: { background: 'raised', padding: 'roomy' }, left: { surface: 'card' }, right: { surface: 'card' } }
        ),
        faqAndVoice(
          'faq',
          [
            { q: 'المنتج مناسب لأنهي نوع بشرة؟', a: 'اكتب هنا نوع البشرة المناسب وطريقة الاستخدام.' },
            { q: 'المكوّنات إيه؟', a: 'اكتب هنا قائمة المكوّنات كاملة لكل منتج.' },
            RETURNS_Q,
          ],
          { padding: 'roomy' }
        ),
        oneCol('cta', [h('cta-h', 'مش عارف تبدأ منين؟', 2), p('cta-p', 'اكتب هنا إزاي العميل يوصلك عشان تساعده يختار روتينه.'), btn('cta-btn', 'اختار روتينك')], {
          section: { background: 'primary', padding: 'roomy' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 4. Precision: an ink opening, spec strip, 3D product, four spec cards, a
  //    spec-style comparison. Slate.
  {
    id: T.watches,
    versionId: V.watches,
    name: 'ساعات وإكسسوارات',
    category: 'watches',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#3F4E63'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [
            h('hero-h', 'مصنوعة عشان تفضل', 1),
            p('hero-p', 'اكتب هنا وصف مجموعتك: الحركة، الخامات، والتفصيلة اللي بتفرق.'),
            btn('hero-btn', 'اتفرّج على التشكيلة'),
          ],
          [img('hero-img', 'صورة الساعة الرئيسية — ارفعها هنا')],
          {
            section: { background: 'ink', padding: 'roomy', width: 'wide' },
            row: { gap: 'loose' },
            left: { verticalAlign: 'center' },
          }
        ),
        oneCol('specs-strip', [marquee('specs-strip-m', ['اكتب هنا نوع الحركة', 'اكتب هنا خامة الهيكل', 'اكتب هنا مقاومة الماء', 'اكتب هنا نوع الزجاج'])], {
          section: { background: 'ink', padding: 'compact', width: 'full' },
        }),
        oneCol('spin', [product3d('spin-e', 'لفّ الساعة وشوفها من كل زاوية')], { section: { padding: 'roomy' } }),
        cardRow(
          'specs',
          [
            { title: 'الحركة', body: 'اكتب هنا نوع الحركة ومصدرها.' },
            { title: 'الهيكل', body: 'اكتب هنا الخامة والتشطيب.' },
            { title: 'الزجاج', body: 'اكتب هنا نوع الزجاج ومقاومته.' },
            { title: 'السوار', body: 'اكتب هنا الخامة وطريقة الإغلاق.' },
          ],
          { section: { background: 'raised', padding: 'roomy' }, gap: 'tight' }
        ),
        oneCol('models', [productList('models-e', 'أحدث الموديلات', 4)], { section: { padding: 'roomy' } }),
        oneCol(
          'compare',
          [
            comparison('compare-e', 'مواصفات بتفرق', 'اكتب هنا اسم متجرك', 'ساعات تانية', [
              ['الحركة', 'اكتب هنا نوع الحركة عندك', 'اكتب هنا وجه المقارنة'],
              ['خامة الهيكل', 'اكتب هنا خامة الهيكل', 'اكتب هنا وجه المقارنة'],
              ['مقاومة الماء', 'اكتب هنا درجة المقاومة', 'اكتب هنا وجه المقارنة'],
              ['الضمان', 'اكتب هنا تفاصيل ضمانك', 'اكتب هنا وجه المقارنة'],
            ]),
          ],
          { section: { padding: 'roomy' } }
        ),
        oneCol('types', [collections('types-e', 'تسوّق حسب النوع', 3)], { section: { background: 'paper', padding: 'roomy' } }),
        faqAndVoice('faq', [{ q: 'في ضمان على الساعة؟', a: 'اكتب هنا تفاصيل الضمان اللي بتقدمه.' }, SHIPPING_Q, RETURNS_Q]),
        oneCol('cta', [h('cta-h', 'اختار ساعتك', 2), btn('cta-btn', 'تسوّق دلوقتي')], {
          section: { background: 'primary', padding: 'compact' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 5. Warm catalogue: a photo-first opening, an orbit of the range, a bento of
  //    rooms, an image-with-text from the workshop. Terracotta.
  {
    id: T.decor,
    versionId: V.decor,
    name: 'بيت وديكور',
    category: 'home_decor',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#C05A3C'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [img('hero-img', 'صورة ركن من بيت حقيقي بقطعك — ارفعها هنا')],
          [
            h('hero-h', 'بيتك يستاهل تفاصيل حلوة', 1),
            p('hero-p', 'اكتب هنا نبذة عن مجموعتك: الخامات، الأسلوب، والقطع اللي بتبدأ بيها أي غرفة.'),
            btn('hero-btn', 'تسوّق للبيت'),
          ],
          {
            spans: [7, 5],
            section: { background: 'paper', padding: 'roomy', width: 'wide' },
            row: { gap: 'loose' },
            right: { verticalAlign: 'center' },
          }
        ),
        oneCol('orbit', [orbit('orbit-e', 'لفّ التشكيلة', 10)], { section: { padding: 'roomy', width: 'full' } }),
        section(
          'rooms',
          [
            row(
              'rooms-r1',
              [
                column('rooms-living', [h('rooms-living-h', 'غرفة المعيشة', 3), p('rooms-living-p', 'اكتب هنا وصف قصير للقطع اللي بتناسب الغرفة دي.'), btn('rooms-living-btn', 'تسوّق القطع', 'outline')], 8, { surface: 'card', verticalAlign: 'end' }),
                column('rooms-bed', [h('rooms-bed-h', 'غرفة النوم', 3), p('rooms-bed-p', 'اكتب هنا وصف قصير للقطع اللي بتناسب الغرفة دي.')], 4, { surface: 'card' }),
              ],
              { gap: 'normal' }
            ),
            row(
              'rooms-r2',
              [
                column('rooms-kitchen', [h('rooms-kitchen-h', 'المطبخ والسفرة', 3), p('rooms-kitchen-p', 'اكتب هنا وصف قصير للقطع اللي بتناسب الغرفة دي.')], 4, { surface: 'card' }),
                column('rooms-office', [h('rooms-office-h', 'المكتب', 3), p('rooms-office-p', 'اكتب هنا وصف قصير للقطع اللي بتناسب الغرفة دي.')], 4, { surface: 'card' }),
                column('rooms-balcony', [h('rooms-balcony-h', 'البلكونة والحديقة', 3), p('rooms-balcony-p', 'اكتب هنا وصف قصير للقطع اللي بتناسب الغرفة دي.')], 4, { surface: 'card' }),
              ],
              { gap: 'normal' }
            ),
          ],
          { padding: 'roomy' }
        ),
        oneCol('materials', [marquee('materials-m', ['اكتب هنا خامتك الأساسية', 'اكتب هنا مكان التصنيع', 'اكتب هنا اللي يميّز تشطيبك'], { tone: 'primary' })], {
          section: { background: 'primary-soft', padding: 'compact', width: 'full' },
        }),
        oneCol('new', [productList('new-e', 'وصل حديثًا', 4)], { section: { padding: 'roomy' } }),
        twoCol(
          'workshop',
          [img('workshop-img', 'صورة من الورشة أو المخزن — ارفعها هنا')],
          [h('workshop-h', 'من ورشتنا لبيتك', 2), p('workshop-p', 'اكتب هنا إزاي بتتصنع القطع، ومين بيشتغل عليها، وإيه اللي بتدقّق فيه قبل ما تخرج.')],
          {
            section: { background: 'raised', padding: 'roomy' },
            row: { gap: 'loose' },
            right: { verticalAlign: 'center' },
          }
        ),
        oneCol('by-room', [collections('by-room-e', 'تسوّق حسب الغرفة', 3)], { section: { padding: 'roomy' } }),
        faqAndVoice('faq', [{ q: 'القطع الكبيرة بتتشحن إزاي؟', a: 'اكتب هنا طريقة شحن القطع الكبيرة وتركيبها.' }, SHIPPING_Q, RETURNS_Q]),
        twoCol(
          'visit',
          [h('visit-h', 'زور المعرض', 2), p('visit-p', 'اكتب هنا مواعيد المعرض وإزاي العميل يحجز زيارة.')],
          [map('visit-map', 'اكتب هنا عنوان المعرض')],
          { section: { background: 'ink', padding: 'roomy' }, left: { verticalAlign: 'center' } }
        ),
      ]),
    ],
  },

  // 6. Playful: a centred tinted opening, big rounded feature cards with icons,
  //    a fast strip, a full FAQ for parents. Bright orange.
  {
    id: T.kids,
    versionId: V.kids,
    name: 'أطفال ولعب',
    category: 'kids_toys',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#F97316'),
    pages: [
      homePage([
        oneCol('hero', [h('hero-h', 'لعب تفرّح وتعلّم', 1), p('hero-p', 'اكتب هنا اللي بيميّز لعبك: الأمان، الخامات، والفكرة ورا كل لعبة.'), btn('hero-btn', 'اتفرّج على اللعب')], {
          section: { background: 'primary-soft', padding: 'roomy' },
          column: { align: 'center' },
        }),
        cardRow(
          'why',
          [
            { icon: 'shield', title: 'أمان', body: 'اكتب هنا معايير الأمان اللي بتلتزم بيها.' },
            { icon: 'heart', title: 'خامات', body: 'اكتب هنا الخامات اللي بتستخدمها.' },
            { icon: 'star', title: 'تعليم', body: 'اكتب هنا إيه اللي الطفل بيتعلّمه من اللعبة.' },
            { icon: 'gift', title: 'تغليف هدايا', body: 'اكتب هنا لو بتقدّم تغليف هدايا وإزاي.' },
          ],
          { section: { padding: 'roomy' }, gap: 'loose' }
        ),
        oneCol('ages', [collections('ages-e', 'تسوّق حسب السن', 4, 4)], { section: { background: 'paper', padding: 'roomy' } }),
        oneCol('top', [productList('top-e', 'الأكثر طلبًا', 4)], { section: { padding: 'roomy' } }),
        oneCol('strip', [marquee('strip-m', ['اكتب هنا فئة عمرية', 'اكتب هنا نوع لعب', 'اكتب هنا مناسبة هدايا', 'اكتب هنا شخصية بيحبها الأطفال'], { speed: 'fast', tone: 'primary' })], {
          section: { background: 'primary-soft', padding: 'compact', width: 'full' },
        }),
        oneCol('moments', [h('moments-h', 'لحظات مع اللعب', 2), gallery('moments-g', '', 4)], {
          section: { padding: 'roomy', width: 'wide' },
          column: { align: 'center' },
        }),
        oneCol(
          'parents',
          [
            faq('parents-e', [
              { q: 'اللعبة مناسبة لأنهي سن؟', a: 'اكتب هنا السن المناسب وتفاصيل الأمان لكل لعبة.' },
              { q: 'الخامات آمنة للأطفال؟', a: 'اكتب هنا الخامات والشهادات اللي عندك.' },
              { q: 'ينفع أغلّفها كهدية؟', a: 'اكتب هنا خيارات التغليف لو بتقدّمها.' },
              SHIPPING_Q,
              RETURNS_Q,
            ]),
          ],
          { section: { background: 'raised', padding: 'roomy' } }
        ),
        oneCol('voice', [testimonial('voice-t')], { section: { padding: 'roomy' }, column: { surface: 'card', align: 'center' } }),
        oneCol('cta', [h('cta-h', 'هدية لعيد ميلاد قريب؟', 2), p('cta-p', 'اكتب هنا إزاي تساعد الأهل يختاروا هدية مناسبة.'), btn('cta-btn', 'اختار هدية')], {
          section: { background: 'primary', padding: 'roomy' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 7. Bold sport: an ink hero band, a stats row the merchant fills, a fast
  //    strip, a countdown deal on a brand-red band. Red.
  {
    id: T.supplements,
    versionId: V.supplements,
    name: 'مكمّلات ولياقة',
    category: 'supplements',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#DC2626'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [
            h('hero-h', 'ادفع حدودك', 1),
            p('hero-p', 'اكتب هنا وصف منتجاتك ومصادرها وشهاداتها.'),
            btn('hero-btn', 'تسوّق المكمّلات'),
          ],
          [img('hero-img', 'صورة قوية للمنتج أو التمرين — ارفعها هنا')],
          {
            spans: [7, 5],
            section: { background: 'ink', padding: 'roomy', width: 'full' },
            left: { verticalAlign: 'center' },
          }
        ),
        section(
          'stats',
          [
            row(
              'stats-r',
              [1, 2, 3, 4].map((i) =>
                column(`stats-c${i}`, [h(`stats-c${i}-n`, 'اكتب الرقم', 2), p(`stats-c${i}-l`, 'اكتب هنا اللي الرقم بيقيسه')], 3, { align: 'center' })
              ),
              { gap: 'tight' }
            ),
          ],
          { background: 'ink', padding: 'compact', width: 'wide' }
        ),
        oneCol('strip', [marquee('strip-m', ['اكتب هنا فئة منتج', 'اكتب هنا فئة منتج', 'اكتب هنا فئة منتج', 'اكتب هنا هدف تدريبي'], { speed: 'fast', tone: 'primary' })], {
          section: { padding: 'compact', width: 'full' },
        }),
        oneCol('cats', [collections('cats-e', 'بروتين، فيتامينات، وأكسسوارات — اكتب أقسامك', 3)], { section: { padding: 'roomy' } }),
        twoCol(
          'deal',
          [h('deal-h', 'عرض محدود', 2), p('deal-p', 'اكتب هنا تفاصيل العرض وشروطه.'), countdown('deal-cd', 'ينتهي العرض خلال', 48)],
          [productCard('deal-card', '')],
          {
            spans: [4, 8],
            section: { background: 'primary', padding: 'roomy' },
            left: { verticalAlign: 'center' },
          }
        ),
        oneCol('top', [productList('top-e', 'الأكثر طلبًا', 4)], { section: { padding: 'roomy' } }),
        oneCol(
          'why',
          [
            comparison('why-e', 'ليه تشتري من عندنا', 'اكتب هنا اسم متجرك', 'مصادر تانية', [
              ['الأصالة', 'اكتب هنا إزاي بتضمن أصالة المنتج', 'اكتب هنا وجه المقارنة'],
              ['تاريخ الصلاحية', 'اكتب هنا سياستك في الصلاحية', 'اكتب هنا وجه المقارنة'],
              ['التخزين', 'اكتب هنا طريقة تخزينك', 'اكتب هنا وجه المقارنة'],
              ['الدعم', 'اكتب هنا إزاي بتساعد العميل يختار', 'اكتب هنا وجه المقارنة'],
            ]),
          ],
          { section: { background: 'raised', padding: 'roomy' } }
        ),
        faqAndVoice('faq', [
          { q: 'إيه طريقة الاستخدام؟', a: 'اكتب هنا الجرعة وطريقة الاستخدام زي ما هي على المنتج.' },
          { q: 'المنتج أصلي ومرخّص؟', a: 'اكتب هنا بيانات المصدر والتراخيص اللي عندك.' },
          RETURNS_Q,
        ]),
        oneCol('cta', [h('cta-h', 'ابدأ خطتك النهاردة', 2), btn('cta-btn', 'تسوّق دلوقتي')], {
          section: { background: 'ink', padding: 'roomy' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 8. Gadget shop: near-black opening, a bento of categories, 3D product, an
  //    "original vs copy" comparison. Near-black.
  {
    id: T.phoneAccessories,
    versionId: V.phoneAccessories,
    name: 'إكسسوارات موبايل',
    category: 'phone_accessories',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#18181B'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [
            h('hero-h', 'كل حاجة لموبايلك', 1),
            p('hero-p', 'كفرات، شواحن، وسماعات — اكتب هنا اللي يميّز تشكيلتك.'),
            btn('hero-btn', 'تسوّق دلوقتي'),
          ],
          [img('hero-img', 'صورة المنتج الرئيسي — ارفعها هنا')],
          {
            section: { background: 'ink', padding: 'roomy', width: 'wide' },
            left: { verticalAlign: 'center' },
          }
        ),
        oneCol('compat', [marquee('compat-m', ['اكتب هنا موديل متوافق', 'اكتب هنا موديل متوافق', 'اكتب هنا موديل متوافق', 'اكتب هنا نوع منفذ الشحن'])], {
          section: { background: 'raised', padding: 'compact', width: 'full' },
        }),
        section(
          'bento',
          [
            row(
              'bento-r1',
              [
                column('bento-cases', [h('bento-cases-h', 'كفرات', 3), p('bento-cases-p', 'اكتب هنا وصف قصير للقسم ده.'), btn('bento-cases-btn', 'تسوّق الكفرات', 'outline')], 6, { surface: 'card', verticalAlign: 'end' }),
                column('bento-chargers', [h('bento-chargers-h', 'شواحن', 3), p('bento-chargers-p', 'اكتب هنا وصف قصير للقسم ده.')], 3, { surface: 'card' }),
                column('bento-audio', [h('bento-audio-h', 'سماعات', 3), p('bento-audio-p', 'اكتب هنا وصف قصير للقسم ده.')], 3, { surface: 'card' }),
              ],
              { gap: 'tight' }
            ),
            row(
              'bento-r2',
              [
                column('bento-cables', [h('bento-cables-h', 'كابلات', 3), p('bento-cables-p', 'اكتب هنا وصف قصير للقسم ده.')], 3, { surface: 'card' }),
                column('bento-mounts', [h('bento-mounts-h', 'حوامل', 3), p('bento-mounts-p', 'اكتب هنا وصف قصير للقسم ده.')], 3, { surface: 'card' }),
                column('bento-screen', [h('bento-screen-h', 'حماية الشاشة', 3), p('bento-screen-p', 'اكتب هنا وصف قصير للقسم ده.'), btn('bento-screen-btn', 'تسوّق الحماية', 'outline')], 6, { surface: 'card', verticalAlign: 'end' }),
              ],
              { gap: 'tight' }
            ),
          ],
          { padding: 'roomy' }
        ),
        oneCol('spin', [product3d('spin-e', 'قلّب المنتج بين إيديك')], { section: { background: 'paper', padding: 'roomy' } }),
        oneCol('top', [productList('top-e', 'الأكثر مبيعًا', 4)], { section: { padding: 'roomy' } }),
        oneCol(
          'genuine',
          [
            comparison('genuine-e', 'أصلي ولا تقليد؟', 'الأصلي', 'التقليد', [
              ['اكتب هنا وجه المقارنة الأول', 'اكتب هنا اللي بيميّز الأصلي', 'اكتب هنا الفرق في التقليد'],
              ['اكتب هنا وجه المقارنة الثاني', 'اكتب هنا اللي بيميّز الأصلي', 'اكتب هنا الفرق في التقليد'],
              ['اكتب هنا وجه المقارنة الثالث', 'اكتب هنا اللي بيميّز الأصلي', 'اكتب هنا الفرق في التقليد'],
            ]),
          ],
          { section: { background: 'ink', padding: 'roomy' } }
        ),
        oneCol('models', [collections('models-e', 'تسوّق حسب موديل موبايلك', 4, 8)], { section: { padding: 'roomy' } }),
        faqAndVoice('faq', [{ q: 'المنتج متوافق مع موبايلي؟', a: 'اكتب هنا الموديلات المتوافقة لكل منتج.' }, SHIPPING_Q, RETURNS_Q], { background: 'paper' }),
        oneCol('cta', [h('cta-h', 'لسه محتار؟', 2), p('cta-p', 'اكتب هنا إزاي العميل يبعتلك موديل موبايله عشان ترشّحله الإكسسوار المناسب.'), btn('cta-btn', 'تسوّق حسب موديلك')], {
          section: { background: 'primary', padding: 'roomy' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },

  // 9. Craft roaster: a photo-first opening, a strip of origins, the
  //    farm-to-cup story on ink, brew-method cards, a subscription band. Brown.
  {
    id: T.coffee,
    versionId: V.coffee,
    name: 'قهوة مختصة',
    category: 'coffee',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#6F4E37'),
    pages: [
      homePage([
        twoCol(
          'hero',
          [img('hero-img', 'صورة الحبوب أو المحمصة — ارفعها هنا')],
          [
            h('hero-h', 'قهوتك، بالطريقة اللي تحبها', 1),
            p('hero-p', 'اكتب هنا نبذة عن محمصتك: من فين بتجيب الحبوب، وإزاي بتحمّصها.'),
            btn('hero-btn', 'اطلب قهوتك'),
          ],
          {
            section: { background: 'paper', padding: 'roomy', width: 'wide' },
            row: { gap: 'loose' },
            right: { verticalAlign: 'center' },
          }
        ),
        oneCol('origins', [marquee('origins-m', ['اكتب هنا اسم المنشأ الأول', 'اكتب هنا اسم المنشأ الثاني', 'اكتب هنا اسم المنشأ الثالث', 'اكتب هنا درجة التحميص'], { speed: 'slow', tone: 'primary' })], {
          section: { background: 'primary-soft', padding: 'compact', width: 'full' },
        }),
        oneCol(
          'story',
          [
            scrollStory('story-e', 'من المزرعة للكوب', [
              ['المزرعة', 'اكتب هنا مصادر الحبوب اللي بتشتغل بيها ومين بيزرعها.'],
              ['التحميص', 'اكتب هنا درجات التحميص اللي بتقدّمها وإزاي بتختارها.'],
              ['الطحن', 'اكتب هنا درجات الطحن المتاحة لكل طريقة تحضير.'],
              ['الكوب', 'اكتب هنا النكهات اللي العميل يتوقّعها في الكوب.'],
            ]),
          ],
          { section: { background: 'ink', padding: 'roomy', width: 'wide' } }
        ),
        oneCol('roasts', [collections('roasts-e', 'تسوّق حسب درجة التحميص', 3)], { section: { padding: 'roomy' } }),
        oneCol('beans', [productList('beans-e', 'حبوب الموسم', 3, 6)], { section: { padding: 'roomy' } }),
        cardRow(
          'brew',
          [
            { title: 'إسبريسو', body: 'اكتب هنا الطحن والنسبة اللي بتنصح بيها.' },
            { title: 'التقطير', body: 'اكتب هنا الطحن والنسبة اللي بتنصح بيها.' },
            { title: 'الفرنش برس', body: 'اكتب هنا الطحن والنسبة اللي بتنصح بيها.' },
          ],
          { section: { background: 'raised', padding: 'roomy' } }
        ),
        oneCol('subscribe', [h('subscribe-h', 'اشتراك شهري', 2), p('subscribe-p', 'اكتب هنا فكرة الاشتراك: بيوصل إمتى، وإيه اللي العميل بيختاره.'), btn('subscribe-btn', 'اشترك')], {
          section: { background: 'primary', padding: 'roomy' },
          column: { align: 'center' },
        }),
        faqAndVoice('faq', [{ q: 'أختار أنهي طحن؟', a: 'اكتب هنا دليل الطحن حسب طريقة التحضير.' }, SHIPPING_Q]),
        twoCol(
          'visit',
          [h('visit-h', 'زور المحمصة', 2), p('visit-p', 'اكتب هنا مواعيد المحمصة ولو في تذوّق للزوار.')],
          [map('visit-map', 'اكتب هنا عنوان المحمصة')],
          { section: { background: 'paper', padding: 'roomy' }, left: { verticalAlign: 'center' } }
        ),
      ]),
    ],
  },

  // 10. High jewellery: a tall shader hero, an orbit of pieces, an editorial
  //     image-with-text, one spotlit piece, one spotlit voice. Champagne gold.
  {
    id: T.jewellery,
    versionId: V.jewellery,
    name: 'مجوهرات وذهب',
    category: 'jewellery',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#C9A961'),
    pages: [
      homePage([
        oneCol('hero', [shaderHero('hero-e', 'قطعة تفضل معاكي سنين', 'اكتبي هنا حكاية علامتك في سطر واحد.', 'اكتشفي التشكيلة', 700)], {
          section: { padding: 'compact', width: 'full' },
        }),
        oneCol('strip', [marquee('strip-m', ['اكتبي هنا العيار', 'اكتبي هنا نوع الأحجار', 'اكتبي هنا شهادة الضمان'], { speed: 'slow' })], {
          section: { background: 'paper', padding: 'compact', width: 'full' },
        }),
        oneCol('orbit', [orbit('orbit-e', 'لفّي التشكيلة', 8)], { section: { padding: 'roomy', width: 'full' } }),
        twoCol(
          'craft',
          [h('craft-h', 'مشغولة بالإيد', 2), p('craft-p', 'اكتبي هنا إزاي بتتصنع القطعة، ومين الصنايعية، وإيه اللي بيميّز شغلكم.')],
          [img('craft-img', 'صورة قريبة من الشغل اليدوي — ارفعيها هنا')],
          {
            spans: [5, 7],
            section: { background: 'paper', padding: 'roomy', width: 'wide' },
            row: { gap: 'loose' },
            left: { verticalAlign: 'center' },
          }
        ),
        oneCol('types', [collections('types-e', 'خواتم، أساور، وسلاسل — اكتبي أقسامك', 3)], { section: { padding: 'roomy' } }),
        oneCol('piece', [productCard('piece-e', 'قطعة الموسم')], { section: { background: 'raised', padding: 'roomy' } }),
        oneCol('new', [productList('new-e', 'وصل حديثًا', 4)], { section: { padding: 'roomy' } }),
        oneCol('voice', [testimonial('voice-t')], {
          section: { background: 'primary-soft', padding: 'roomy' },
          column: { align: 'center' },
        }),
        twoCol(
          'care',
          [list('care-l', 'العناية بالقطعة', ['اكتبي هنا إزاي العميلة تحافظ على القطعة', 'اكتبي هنا إزاي تتخزن', 'اكتبي هنا لو بتقدّمي تلميع أو صيانة'])],
          [
            faq('care-faq', [
              { q: 'إيه خامة القطعة وعيارها؟', a: 'اكتبي هنا الخامة والعيار وشهادة الضمان لكل قطعة.' },
              PAYMENT_Q,
              RETURNS_Q,
            ]),
          ],
          { left: { surface: 'card' } }
        ),
        oneCol('cta', [h('cta-h', 'عايزة قطعة بتصميم خاص؟', 2), p('cta-p', 'اكتبي هنا إزاي بتستقبلي طلبات التفصيل.'), btn('cta-btn', 'اطلبي التصميم')], {
          section: { background: 'ink', padding: 'roomy' },
          column: { align: 'center' },
        }),
      ]),
    ],
  },
];

module.exports = {
  up: async (queryInterface) => {
    const now = new Date();

    await queryInterface.bulkInsert(
      'templates',
      TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        thumbnail_url: t.thumbnailUrl,
        is_published: true,
        created_at: now,
        updated_at: now,
      }))
    );

    await queryInterface.bulkInsert(
      'template_versions',
      TEMPLATES.map((t) => ({
        id: t.versionId,
        template_id: t.id,
        version: 1,
        global_styles: JSON.stringify(t.globalStyles),
        pages: JSON.stringify(t.pages),
        sections: JSON.stringify([]),
        is_active: true,
        created_at: now,
        updated_at: now,
      }))
    );
  },

  down: async (queryInterface, Sequelize) => {
    const ids = TEMPLATES.map((t) => t.id);
    await queryInterface.bulkDelete('template_versions', { template_id: { [Sequelize.Op.in]: ids } });
    await queryInterface.bulkDelete('templates', { id: { [Sequelize.Op.in]: ids } });
  },
};
