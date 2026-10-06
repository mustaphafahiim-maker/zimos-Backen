'use strict';

const { supportReply } = require('./sandboxSupport');

/**
 * Sandbox answers for the P2 features (../featuresP2.js, item 97): fixed
 * rules over the facts the request carries, so each feature can be tried end
 * to end before a real provider is chosen. They invent nothing: the review
 * scores the page's measured facts, the ads use the product's own words and
 * pictures, the store plan is a marked-up starting draft, and the reply comes
 * from the store's facts and the customer's own orders.
 */

const AR = (dialect) => dialect !== 'english' && dialect !== 'french';

// --- page_review -------------------------------------------------------------

function pageReview({ input, context }) {
  const f = context.facts || {};
  const m = context.metrics || {};
  const ar = AR(input.dialect);
  const recs = [];
  const add = (severity, en, enDetail, arTitle, arDetail, cost) => recs.push({ severity, title: ar ? arTitle : en, detail: ar ? arDetail : enDetail, cost });

  if (!f.orderFormSection && !f.firstCallToActionSection) {
    add('high', 'Add a way to order', 'The page has no order form and no button. Add a COD form or a "buy now" button.', 'ضيف طريقة للطلب', 'الصفحة مافيهاش فورم طلب ولا زرار. ضيف فورم الدفع عند الاستلام أو زرار "اطلب دلوقتي".', 30);
  } else if ((f.orderFormSection || f.firstCallToActionSection) > 3) {
    const at = f.orderFormSection || f.firstCallToActionSection;
    add('high', 'Bring the order form up', `The first way to order is in section ${at} of ${f.sections}. Put a button or the form in the first two sections.`, 'طلّع فورم الطلب لفوق', `أول طريقة للطلب في القسم ${at} من ${f.sections}. حط زرار أو الفورم في أول قسمين.`, 15);
  }
  if (!f.showsPrice) add('medium', 'Show the price', 'No element on the page shows the price. Add a price block near the order button.', 'اعرض السعر', 'مفيش عنصر في الصفحة بيعرض السعر. ضيف السعر جنب زرار الطلب.', 10);
  if (!f.guaranteeMentioned) add('medium', 'State a guarantee', 'Nothing on the page mentions a guarantee or returns. Say what happens if the customer is not happy.', 'وضّح الضمان', 'مفيش أي ذكر لضمان أو استرجاع. قول للعميل إيه اللي هيحصل لو المنتج ماعجبهوش.', 10);
  if (!f.socialProof) add('medium', 'Show real reviews', 'The page has no reviews or testimonials. Add the reviews block — it shows your approved reviews.', 'اعرض تقييمات حقيقية', 'الصفحة مافيهاش تقييمات. ضيف بلوك التقييمات — بيعرض التقييمات اللي وافقت عليها.', 10);
  if (!f.faq) add('low', 'Answer the usual questions', 'Add an FAQ: delivery time, payment, returns.', 'جاوب على الأسئلة المعتادة', 'ضيف أسئلة شائعة: مدة التوصيل، طرق الدفع، الاسترجاع.', 5);
  if (f.images === 0) add('high', 'Add product pictures', 'The page has no pictures.', 'ضيف صور للمنتج', 'الصفحة مافيهاش صور.', 15);
  else if (f.imagesWithoutDescription > 0) add('low', 'Describe the pictures', `${f.imagesWithoutDescription} of ${f.images} pictures have no description (alt text).`, 'اكتب وصف للصور', `${f.imagesWithoutDescription} من ${f.images} صور مالهاش وصف.`, 3);
  if (f.sections > 12) add('low', 'Shorten the page', `${f.sections} sections is long; cut what does not help the decision.`, 'قصّر الصفحة', `${f.sections} قسم كتير؛ شيل اللي مش بيساعد العميل يقرر.`, 4);
  if (m.views >= 100 && typeof m.ordersFromVisitorsWhoLandedHere === 'number' && m.ordersFromVisitorsWhoLandedHere === 0) {
    add('high', 'Visitors leave without ordering', `${m.views} views in 30 days and no order from visitors who landed here. Check the offer and the form first.`, 'الزوار بيمشوا من غير طلب', `${m.views} مشاهدة في 30 يوم ومفيش طلب من اللي دخلوا من هنا. راجع العرض والفورم الأول.`, 10);
  }

  const score = Math.max(5, 100 - recs.reduce((sum, r) => sum + r.cost, 0));
  const order = { high: 0, medium: 1, low: 2 };
  const recommendations = recs.sort((a, b) => order[a.severity] - order[b.severity]).map(({ cost, ...r }) => r);
  const summary = ar
    ? `تقييم تجريبي من مزوّد الاختبار، محسوب من محتوى الصفحة: ${f.sections} أقسام و${f.elements} عنصر. ${recommendations.length ? `فيه ${recommendations.length} تحسينات مقترحة.` : 'الصفحة فيها الأساسيات.'}`
    : `A test-provider review computed from the page itself: ${f.sections} sections, ${f.elements} elements. ${recommendations.length ? `${recommendations.length} suggested fixes.` : 'The basics are there.'}`;
  return { score, summary, recommendations };
}

// --- ad_creatives -----------------------------------------------------------

function adCreatives({ input, context }) {
  const p = context.product;
  const ar = AR(input.dialect);
  const offer = p.specialOfferText || '';
  const price = p.price || '';
  const feature = p.features[0] || '';
  const headlines = ar
    ? [p.name, price ? `${p.name} بـ ${price}` : `${p.name} — اطلبه دلوقتي`, 'الدفع عند الاستلام', offer].filter(Boolean)
    : [p.name, price ? `${p.name} for ${price}` : `${p.name} — order now`, 'Pay on delivery', offer].filter(Boolean);
  const primaryTexts = ar
    ? [
        `${p.name}${feature ? ` — ${feature}` : ''}.\n${offer ? `${offer}\n` : ''}اطلب دلوقتي والدفع عند الاستلام.`,
        `بتدوّر على ${p.name}؟${price ? ` سعره ${price}` : ''}. اطلب من الموقع وهنكلمك نأكد الطلب.`,
      ]
    : [
        `${p.name}${feature ? ` — ${feature}` : ''}.\n${offer ? `${offer}\n` : ''}Order now and pay on delivery.`,
        `Looking for ${p.name}?${price ? ` It's ${price}.` : ''} Order on the site and we'll call to confirm.`,
      ];
  const formats = ['square', 'story', 'landscape'];
  const banners = p.images.slice(0, 3).map((imageUrl, i) => ({
    imageUrl,
    headline: headlines[i % headlines.length].slice(0, 60),
    subline: (feature || (ar ? 'اطلب دلوقتي' : 'Order now')).slice(0, 140),
    badge: (offer || (ar ? 'الدفع عند الاستلام' : 'Cash on delivery')).slice(0, 40),
    format: formats[i % formats.length],
  }));
  return { headlines: headlines.map((h) => h.slice(0, 60)), primaryTexts, banners };
}

// --- store_builder ----------------------------------------------------------

function storeBuilder({ input, context }) {
  const ar = AR(input.dialect);
  let n = 0;
  const id = (prefix) => `${prefix}-${++n}`;
  const section = (...elements) => ({
    id: id('s'),
    type: 'section',
    rows: [{ id: id('r'), type: 'row', columns: [{ id: id('c'), type: 'column', span: 12, elements: elements.map(([type, props]) => ({ id: id('e'), type, props })) }] }],
  });
  const name = input.storeName;
  const niche = input.niche;
  const t = ar
    ? {
        tagline: `أفضل ${niche} — نص تجريبي، اكتب جملتك أنت.`,
        shop: 'تسوّق الآن',
        newest: 'وصل حديثًا',
        categories: 'الأقسام',
        why: 'ليه تشتري مننا؟',
        whyText: 'اكتب هنا 3 أسباب حقيقية: الجودة، التوصيل، خدمة العملاء.',
        faq: 'أسئلة شائعة',
        faqs: [
          { q: 'مدة التوصيل كام؟', a: 'اكتب مدة التوصيل الفعلية [ ... ].' },
          { q: 'إزاي أدفع؟', a: 'اكتب طرق الدفع اللي متجرك بيقبلها [ ... ].' },
        ],
        collections: [`${niche} — الأكثر مبيعًا`, 'وصل حديثًا', 'عروض'],
        colDesc: 'وصف تجريبي — اكتب وصف القسم.',
        shipping: `${name} بيوصّل خلال [ ... ] أيام عمل. مصاريف الشحن بتظهر قبل تأكيد الطلب.`,
        returns: `تقدر ترجع المنتج خلال [ ... ] يوم من الاستلام بحالته الأصلية. تواصل معانا على [ ... ].`,
        privacy: `${name} بيجمع الاسم والموبايل والعنوان بس عشان يوصّل طلبك، ومش بيبيع بياناتك لحد.`,
      }
    : {
        tagline: `The best ${niche} — sample text, write your own line.`,
        shop: 'Shop now',
        newest: 'New arrivals',
        categories: 'Categories',
        why: 'Why shop with us?',
        whyText: 'Write 3 real reasons here: quality, delivery, customer care.',
        faq: 'Questions',
        faqs: [
          { q: 'How long is delivery?', a: 'Write your real delivery time [ ... ].' },
          { q: 'How can I pay?', a: 'Write the payment methods you accept [ ... ].' },
        ],
        collections: [`${niche} — best sellers`, 'New arrivals', 'Offers'],
        colDesc: 'Sample description — write your own.',
        shipping: `${name} delivers within [ ... ] working days. The delivery cost shows before you confirm.`,
        returns: `You can return an item within [ ... ] days of delivery in its original condition. Contact us at [ ... ].`,
        privacy: `${name} collects only your name, phone and address to deliver your order, and never sells your data.`,
      };
  const tree = {
    version: 1,
    sections: [
      section(['heading', { text: name, level: 1 }], ['text', { text: t.tagline }], ['button', { label: t.shop, href: '/products', variant: 'primary' }]),
      section(['heading', { text: t.newest, level: 2 }], ['product_list', { title: '', source: 'newest', limit: 8, columns: 4 }]),
      section(['heading', { text: t.categories, level: 2 }], ['collection_list', { title: '', limit: 6, columns: 3 }]),
      section(['heading', { text: t.why, level: 2 }], ['text', { text: t.whyText }]),
      section(['faq', { title: t.faq, items: t.faqs }]),
    ],
  };
  const themes = Array.isArray(context.themes) ? context.themes : [];
  return {
    theme: { key: (themes[0] && themes[0].key) || 'original', primaryColor: input.color },
    home: { title: name, tree },
    collections: t.collections.map((c) => ({ name: c, description: t.colDesc })),
    policies: { shipping: t.shipping, returns: t.returns, privacy: t.privacy },
  };
}

// --- wa_reply ----------------------------------------------------------------

/** The customer service bot's rules (sandboxSupport.js), as a suggestion for a person to send. */
function waReply({ context }) {
  const answer = supportReply({ input: { message: context.lastMessage, dialect: context.dialect }, context: context.brain });
  return { reply: answer.text };
}

module.exports = { page_review: pageReview, ad_creatives: adCreatives, store_builder: storeBuilder, wa_reply: waReply };
