'use strict';

/**
 * Ten niche store templates for the Egyptian market, offered on the same
 * merchant "pick a template" screen as the five general ones
 * (20260103000000-website-templates.js). Same shape: one active version per
 * template whose `pages` array holds a real home page, deep-copied into the
 * merchant's website when they choose it.
 *
 * Two rules the copy follows:
 *  - Every template gets a `primaryColor` that suits its niche, so the picker
 *    is not ten shades of the platform blue.
 *  - Nothing is claimed on the merchant's behalf. Testimonials ship empty for
 *    the merchant to paste a real one in, and FAQ answers are placeholders
 *    ("اكتب هنا سياسة الاسترجاع بتاعتك") — never an invented policy, rating,
 *    delivery time or guarantee.
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
const el = (id, type, props = {}) => ({ id, type, props });
const column = (id, elements, span = 12) => ({ id, type: 'column', span, elements });
const row = (id, columns) => ({ id, type: 'row', columns });
const section = (id, rows) => ({ id, type: 'section', rows });
const oneCol = (id, elements) => section(id, [row(`${id}-r`, [column(`${id}-c`, elements)])]);

const heroSection = (title, subtitle, cta) =>
  oneCol('hero', [
    el('hero-h', 'heading', { text: title, level: 1 }),
    el('hero-p', 'text', { text: subtitle }),
    el('hero-btn', 'button', { label: cta, href: '/products', variant: 'primary' }),
  ]);

const productListSection = (title) =>
  oneCol('products', [el('products-e', 'product_list', { title, source: 'newest', limit: 8, columns: 4 })]);

const productCardSection = (title) =>
  oneCol('offer', [el('offer-e', 'product_card', { title, showPrice: true, showBuyButton: true })]);

const collectionListSection = (title) =>
  oneCol('collections', [el('collections-e', 'collection_list', { title, limit: 6, columns: 3 })]);

const gallerySection = (title) =>
  oneCol('gallery', [el('gallery-e', 'gallery', { title, images: [], columns: 3 })]);

// Ships empty on purpose: the merchant pastes a real customer's words here.
const testimonialSection = () =>
  oneCol('testimonial', [el('testimonial-e', 'testimonial', { quote: '', author: '', rating: 0 })]);

const faqSection = (items) => oneCol('faq', [el('faq-e', 'faq', { title: 'الأسئلة الشائعة', items })]);

const countdownSection = (label) =>
  oneCol('countdown', [el('countdown-e', 'countdown', { label, endsInHours: 24 })]);

// --- immersive sections ----------------------------------------------------
const shaderHeroSection = (title, subtitle, ctaLabel) =>
  oneCol('shader-hero', [
    el('shader-hero-e', 'shader_hero', { title, subtitle, ctaLabel, ctaHref: '/products', height: 520 }),
  ]);

// `productId` empty -> the storefront shows the merchant's first product, and
// `modelUrl` empty -> it uses the product's own GLB. No model, no block.
const product3dSection = (title) =>
  oneCol('product-3d', [el('product-3d-e', 'product_3d', { title, productId: '', modelUrl: '' })]);

const orbitGallerySection = (title, limit = 8) =>
  oneCol('orbit', [el('orbit-e', 'orbit_gallery', { title, limit, collectionId: '' })]);

// Images left empty for the merchant to upload their own.
const scrollStorySection = (title, steps) =>
  oneCol('story', [
    el('story-e', 'scroll_story', { title, steps: steps.map((s) => ({ title: s.title, body: s.body, image: '' })) }),
  ]);

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

const TEMPLATES = [
  {
    id: T.modest,
    versionId: V.modest,
    name: 'عبايات وأزياء محتشمة',
    category: 'modest_fashion',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#6D28D9'),
    pages: [
      homePage([
        heroSection('عبايات بتناسب يومك كله', 'قصّات وخامات تختاريها بنفسك، واللبس اللي يريحك في أي مناسبة.', 'تسوّقي الكولكشن'),
        collectionListSection('تسوّقي حسب الستايل'),
        gallerySection('لوك بوك — ارفعي صور قطعك هنا'),
        productListSection('وصل حديثًا'),
        faqSection([{ q: 'إزاي أختار المقاس المناسب؟', a: 'اكتب هنا جدول المقاسات وطريقة القياس بتاعتك.' }, RETURNS_Q]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.perfume,
    versionId: V.perfume,
    name: 'عطور وعود',
    category: 'perfume',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#7C2D12'),
    pages: [
      homePage([
        shaderHeroSection('عطر يفضل معاك', 'مجموعة عطور وعود مختارة — اكتب هنا حكاية علامتك.', 'اكتشف العطور'),
        collectionListSection('عطور شرقية، فرنساوي، وعود'),
        productListSection('الأكثر طلبًا في متجرك'),
        scrollStorySection('من الزيت للزجاجة', [
          { title: 'اختيار الزيوت', body: 'اكتب هنا إزاي بتختار زيوتك ومصادرها.' },
          { title: 'التعتيق', body: 'اكتب هنا مدة التعتيق وطريقتها.' },
          { title: 'التعبئة', body: 'اكتب هنا تفاصيل التعبئة والتغليف.' },
        ]),
        faqSection([{ q: 'العطر بيفضل قد إيه؟', a: 'اكتب هنا تفاصيل الثبات والتركيز لكل منتج.' }, RETURNS_Q]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.skincare,
    versionId: V.skincare,
    name: 'العناية بالبشرة',
    category: 'skincare',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#10B981'),
    pages: [
      homePage([
        heroSection('روتين بسيط لبشرتك', 'منتجات عناية بمكوّنات واضحة — اكتب هنا اللي يميّز منتجاتك.', 'ابدأ الروتين'),
        scrollStorySection('الروتين خطوة بخطوة', [
          { title: 'الخطوة الأولى — التنظيف', body: 'اكتب هنا المنتج والطريقة.' },
          { title: 'الخطوة التانية — الترطيب', body: 'اكتب هنا المنتج والطريقة.' },
          { title: 'الخطوة التالتة — الحماية من الشمس', body: 'اكتب هنا المنتج والطريقة.' },
          { title: 'قبل وبعد', body: 'ارفع هنا صور حقيقية بعد إذن العميل.' },
        ]),
        productListSection('منتجات الروتين'),
        faqSection([
          { q: 'المنتج مناسب لأنهي نوع بشرة؟', a: 'اكتب هنا نوع البشرة المناسب وطريقة الاستخدام.' },
          { q: 'المكوّنات إيه؟', a: 'اكتب هنا قائمة المكوّنات كاملة لكل منتج.' },
          RETURNS_Q,
        ]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.watches,
    versionId: V.watches,
    name: 'ساعات وإكسسوارات',
    category: 'watches',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#334155'),
    pages: [
      homePage([
        heroSection('ساعة تكمّل إطلالتك', 'تشكيلة ساعات وإكسسوارات — اكتب هنا وصف مجموعتك.', 'اتفرّج على التشكيلة'),
        product3dSection('لفّ الساعة وشوفها من كل زاوية'),
        productListSection('أحدث الموديلات'),
        faqSection([{ q: 'في ضمان على الساعة؟', a: 'اكتب هنا تفاصيل الضمان اللي بتقدمه.' }, SHIPPING_Q, RETURNS_Q]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.decor,
    versionId: V.decor,
    name: 'بيت وديكور',
    category: 'home_decor',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#0F766E'),
    pages: [
      homePage([
        heroSection('بيتك يستاهل تفاصيل حلوة', 'قطع ديكور وإكسسوارات منزل — اكتب هنا نبذة عن مجموعتك.', 'تسوّق للبيت'),
        orbitGallerySection('لفّ التشكيلة', 10),
        collectionListSection('تسوّق حسب الغرفة'),
        productListSection('وصل حديثًا'),
        faqSection([SHIPPING_Q, RETURNS_Q]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.kids,
    versionId: V.kids,
    name: 'أطفال ولعب',
    category: 'kids_toys',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#F97316'),
    pages: [
      homePage([
        heroSection('لعب تفرّح وتعلّم', 'تشكيلة لعب ومستلزمات أطفال — اكتب هنا اللي بيميّز منتجاتك.', 'اتفرّج على اللعب'),
        collectionListSection('تسوّق حسب السن'),
        productListSection('الأكثر طلبًا'),
        gallerySection('صور المنتجات — ارفع صورك هنا'),
        faqSection([
          { q: 'اللعبة مناسبة لأنهي سن؟', a: 'اكتب هنا السن المناسب وتفاصيل الأمان لكل لعبة.' },
          SHIPPING_Q,
          RETURNS_Q,
        ]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.supplements,
    versionId: V.supplements,
    name: 'مكمّلات ولياقة',
    category: 'supplements',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#DC2626'),
    pages: [
      homePage([
        heroSection('مكمّلاتك في مكان واحد', 'اكتب هنا وصف منتجاتك ومصادرها وشهاداتها.', 'تسوّق المكمّلات'),
        collectionListSection('بروتين، فيتامينات، وأكسسوارات'),
        productListSection('الأكثر طلبًا'),
        countdownSection('ينتهي العرض خلال'),
        faqSection([
          { q: 'إيه طريقة الاستخدام؟', a: 'اكتب هنا الجرعة وطريقة الاستخدام زي ما هي على المنتج.' },
          { q: 'المنتج أصلي ومرخّص؟', a: 'اكتب هنا بيانات المصدر والتراخيص اللي عندك.' },
          RETURNS_Q,
        ]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.phoneAccessories,
    versionId: V.phoneAccessories,
    name: 'إكسسوارات موبايل',
    category: 'phone_accessories',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#18181B'),
    pages: [
      homePage([
        heroSection('كل حاجة لموبايلك', 'كفرات، شواحن، وسماعات — اكتب هنا تفاصيل تشكيلتك.', 'تسوّق دلوقتي'),
        collectionListSection('تسوّق حسب الموديل'),
        product3dSection('شوف المنتج بثلاثة أبعاد'),
        productListSection('الأكثر مبيعًا'),
        faqSection([{ q: 'المنتج متوافق مع موبايلي؟', a: 'اكتب هنا الموديلات المتوافقة لكل منتج.' }, SHIPPING_Q, RETURNS_Q]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.coffee,
    versionId: V.coffee,
    name: 'قهوة مختصة',
    category: 'coffee',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#6F4E37'),
    pages: [
      homePage([
        heroSection('قهوتك، بالطريقة اللي تحبها', 'حبوب مختصة وطرق تحضير — اكتب هنا نبذة عن محمصتك.', 'اطلب قهوتك'),
        scrollStorySection('من المزرعة للكوب', [
          { title: 'المصدر', body: 'اكتب هنا مصادر الحبوب اللي بتشتغل بيها.' },
          { title: 'التحميص', body: 'اكتب هنا درجات التحميص اللي بتقدّمها.' },
          { title: 'الطحن والتحضير', body: 'اكتب هنا طرق الطحن والتحضير المناسبة.' },
        ]),
        collectionListSection('تسوّق حسب درجة التحميص'),
        productListSection('وصل حديثًا'),
        faqSection([{ q: 'أختار أنهي طحن؟', a: 'اكتب هنا دليل الطحن حسب طريقة التحضير.' }, SHIPPING_Q]),
        testimonialSection(),
      ]),
    ],
  },
  {
    id: T.jewellery,
    versionId: V.jewellery,
    name: 'مجوهرات وذهب',
    category: 'jewellery',
    thumbnailUrl: null, // rendered live by the template gallery; no hosted image yet
    globalStyles: styles('#B8860B'),
    pages: [
      homePage([
        shaderHeroSection('قطعة تفضل معاكي سنين', 'مجوهرات مشغولة بالإيد — اكتب هنا حكاية علامتك.', 'اكتشفي التشكيلة'),
        orbitGallerySection('لفّي التشكيلة', 8),
        productCardSection('القطعة المميزة'),
        productListSection('وصل حديثًا'),
        faqSection([
          { q: 'إيه خامة القطعة وعيارها؟', a: 'اكتب هنا الخامة والعيار وشهادة الضمان لكل قطعة.' },
          PAYMENT_Q,
          RETURNS_Q,
        ]),
        testimonialSection(),
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
