'use strict';

/**
 * The Uokids store template: the home page of uokids.com, rebuilt section by
 * section from the showcase elements (modules/pages/showcaseElements.js) and
 * worn with the "uokids" store theme.
 *
 * Unlike the niche templates this one ships with real copy and pictures — it
 * is one store's own page, kept as a template so it can be applied to that
 * store's workspace in any database. The pictures and videos still live on
 * the store's old CDN (`MEDIA` below); swap that one constant when they move
 * into the media library. Product bands name collections by slug and the
 * need picker names products by slug, so they fill in once the catalogue
 * carries the same slugs.
 */

const TEMPLATE_ID = 'e0000000-0000-4000-8000-000000000001';
const VERSION_ID = 'e1000000-0000-4000-8000-000000000001';

const MEDIA = 'https://uokids.com/cdn/shop';
const file = (name, width) => `${MEDIA}/files/${name}?format=jpg&width=${width}`;
const collection = (slug) => `/products?collection=${slug}`;

const PINK = '#e8415b';

// --- tiny page-tree builders (shape enforced by pages/pageTree.js) ---------
const el = (id, type, props) => ({ id, type, props });
/** One showcase element on its own full-bleed section. */
const band = (id, type, props) => ({
  id,
  type: 'section',
  settings: { width: 'full', padding: 'tight' },
  rows: [{ id: `${id}-r`, type: 'row', columns: [{ id: `${id}-c`, type: 'column', span: 12, elements: [el(`${id}-e`, type, props)] }] }],
});

const CART_LABEL = { cartLabel: 'أضيفي للسلة', cartLabelEn: 'Add to cart' };

const home = [
  band('hero', 'hero_slider', {
    slides: [
      {
        image: file('IMG_1110.png', 2400),
        mobileImage: file('IMG_1107.png', 1100),
        imageEn: file('IMG_1111.png', 2400),
        mobileImageEn: file('IMG_1105.png', 1100),
        alt: 'يوكيدز — باقات البيبي',
        buttonLabel: 'وفّري أكتر مع الباقات',
        buttonLabelEn: 'Save more with bundles',
        buttonHref: collection('uokids-bundles'),
        side: 'center',
        vertical: 'bottom',
        contentWidth: 620,
        text: 'dark',
      },
      {
        image: file('ChatGPT_Image_Sep_4_2026_06_35_11_PM.png', 2400),
        mobileImage: file('ChatGPT_Image_Sep_4_2026_06_22_16_PM.png', 1100),
        imageEn: file('ChatGPT_Image_Sep_4_2026_06_35_59_PM.png', 2400),
        mobileImageEn: file('ChatGPT_Image_Sep_4_2026_06_12_39_PM.png', 1100),
        alt: 'يوكيدز — دليلك في رحلة الأمومة',
        buttonLabel: 'وفّري أكتر مع الباقات',
        buttonLabelEn: 'Save more with bundles',
        buttonHref: collection('uokids-bundles'),
        side: 'end',
        vertical: 'bottom',
        contentWidth: 400,
        text: 'dark',
      },
    ],
    autoplay: true,
    seconds: 5,
    startDelay: 25,
    arrows: true,
    dots: true,
    wave: true,
    height: 620,
    heightTablet: 520,
    label: 'العروض الرئيسية',
    labelEn: 'Featured offers',
  }),

  band('categories', 'category_tiles', {
    heading: 'تسوّقي حسب الفئة',
    headingEn: 'Shop by category',
    columns: 3,
    columnsMobile: 3,
    tone: 'plain',
    items: [
      { image: file('cozy-care-bundle-oval-2588008.jpg', 1000), title: 'باقات يوكيدز', titleEn: 'UOKIDS bundles', href: collection('uokids-bundles') },
      { image: file('self-feeding-pillow-9337569.png', 1000), title: 'مستلزمات الرضاعة', titleEn: 'Feeding', href: collection('feeding-1') },
      { image: file('baby-bed-uokids-3259156.png', 1000), title: 'النوم والراحة', titleEn: 'Sleep & comfort', href: collection('sleep-comfort') },
      { image: file('mom-bag-2048707.png', 1000), title: 'الخروجات والتغيير', titleEn: 'Outings & changing', href: collection('travel-changing') },
      { image: file('sgad-byano-mosyky-llatfal-1141495.jpg', 1000), title: 'ألعاب', titleEn: 'Toys', href: collection('toys') },
      { image: file('baby-bouncer-uokids-9739773.png', 1000), title: 'الأكثر مبيعًا', titleEn: 'Best sellers', href: collection('best-seller') },
    ],
  }),

  band('trust', 'trust_strip', {
    tone: 'plain',
    items: [
      { icon: 'box', title: 'معاينة قبل الدفع', titleEn: 'Inspect before payment', text: 'تفتحي وتتأكدي قدام المندوب قبل ما تدفعي', textEn: 'Open it and check it with the courier before you pay' },
      { icon: 'cash', title: 'الدفع عند الاستلام', titleEn: 'Cash on delivery', text: 'مفيش دفع مقدم — كاش لما يوصلك', textEn: 'Nothing up front — pay cash when it arrives' },
      { icon: 'truck', title: 'شحن مجاني للطلبات فوق 1,500 جنيه', titleEn: 'Free shipping on orders over EGP 1,500', text: 'لكل محافظات مصر — يوصلك خلال 2-4 أيام', textEn: 'All over Egypt — delivered in 2-4 days' },
      { icon: 'shield', title: 'حماية 14 يوم للعيب الصناعي', titleEn: '14-day manufacturing-defect protection', text: 'كلّمينا على الواتساب ونستبدله', textEn: 'Message us on WhatsApp and we replace it' },
    ],
  }),

  band('bundles', 'bundle_cards', {
    heading: 'باندلز مختارة ليكي',
    headingEn: 'Bundles picked for you',
    subheading: 'وفّري أكتر واختاري الباندل المناسب لمرحلة بيبيك',
    subheadingEn: "Save more with a bundle made for your baby's stage",
    badge: 'وفري اكتر',
    badgeEn: 'Save More !',
    collection: 'uokids-bundles',
    limit: 4,
    mobileOnly: true,
    tone: 'plain',
    ...CART_LABEL,
  }),

  band('needs', 'need_picker', {
    kicker: 'اختاري حسب احتياجك',
    kickerEn: 'SHOP BY NEED',
    heading: 'إيه اللي محتاجاه دلوقتي؟',
    headingEn: 'What do you need right now?',
    sub: 'اختاري احتياجك دلوقتي — وشوفي الباقة اللي تناسبه.',
    subEn: 'Pick what you need today - and see the bundle that fits.',
    ctaLabel: 'شوفي الباقة',
    ctaLabelEn: 'View the bundle',
    moreLabel: 'وكمان في المجموعة',
    moreLabelEn: 'Also in this set',
    saveLabel: 'وفّري [amount] جنيه',
    saveLabelEn: 'Save [amount] EGP',
    tone: 'cool',
    stages: [
      {
        icon: 'moon',
        name: 'البداية',
        nameEn: 'Getting started',
        pain: 'بتجهّزي لأول مرة؟',
        painEn: 'Getting ready for the first time?',
        desc: 'أول شهور فيها قرارات كتيرة، وصعب تعرفي إيه اللي هيتستخدم فعلًا. الباقة دي فيها الأساسيات اللي بتتستخدم من أول يوم — من غير حاجة هتتساب في الدولاب.',
        descEn: 'The first months are all decisions, and you still do not know what you will actually use. This is the least you need - without buying things that end up in the cupboard.',
        items: ['مكان نوم آمن جنبك', 'وضعية رضاعة مريحة لضهرك', 'تغطية مريحة وقت الرضاعة'],
        itemsEn: ['A safe place to sleep beside you', 'A feeding position that spares your back', 'A comfortable cover while you feed'],
        productId: 'uokids-baby-essentials-bundle',
        altProductId: 'uokids-cozy-care-bundle',
      },
      {
        icon: 'bottle',
        name: 'الرضاعة',
        nameEn: 'Feeding',
        pain: 'الرضاعة واخدة وقت طويل؟',
        painEn: 'Is feeding taking a long time?',
        desc: 'الرضاعة بتاخد وقت طويل، والوضعية الغلط بتتعب ضهرك وذراعك. المخدة بترفع بيبي لمستوى مريح ليكي، والساتر بيخليكي ترضعي برا البيت من غير ما تدوري على مكان مناسب.',
        descEn: 'Feeding takes a long time, and the wrong position tires your back and arm. The pillow lifts your baby to a level that is comfortable for you, and the cover lets you feed outside without hunting for the right spot.',
        items: ['دعم لضهرك وذراعك وقت الرضعة', 'خصوصية مريحة وإنتي برا البيت', 'أوفر من شراء القطعتين منفصلين'],
        itemsEn: ['Support for your back and arm while you feed', 'Comfortable privacy when you are out', 'Cheaper than buying the two pieces apart'],
        productId: 'nursing-bundle',
        altProductId: 'uokids-cozy-care-bundle',
      },
      {
        icon: 'bag',
        name: 'الخروج',
        nameEn: 'Going out',
        pain: 'الخروج محتاج تجهيز كتير؟',
        painEn: 'Does going out take a lot of prep?',
        desc: 'التجهيز للخروج بياخد وقت أطول من الخروج نفسه. الباقة دي بتخلّي التجهيز دقايق، وتمشي وإيدك فاضية.',
        descEn: 'Packing for an outing takes longer than the outing itself. This set cuts the packing to minutes and lets you walk with your hands free.',
        items: ['تغيير في أي مكان', 'حمل مريح للاتنين', 'كل حاجة في شنطة واحدة'],
        itemsEn: ['Changing anywhere', 'Comfortable carrying for both', 'Everything in one bag'],
        productId: 'uokids-on-the-go-bundle',
        altProductId: 'uokids-baby-daily-bundle',
      },
      {
        icon: 'clock',
        name: 'اليوم كامل',
        nameEn: 'The whole day',
        pain: 'عايزة اليوم كله يتغطّي؟',
        painEn: 'Want the whole day covered?',
        desc: 'البيت والخروج مش حاجتين منفصلين — اليوم واحد. الباقة دي بتغطّي اليوم كله بقرار واحد، وأوفر من شرائها على مرتين.',
        descEn: 'Home and outings are not two separate things - the day is one. This set covers the whole day in one decision, and costs less than buying them twice.',
        items: ['البيت والخروج في قرار واحد', 'من غير حاجة ناقصة في النص', 'أوفر من شرائها منفصلة'],
        itemsEn: ['Home and outings in one decision', 'Nothing missing halfway', 'Cheaper than buying them apart'],
        productId: 'uokids-baby-daily-bundle',
        altProductId: 'uokids-first-year-bundle',
      },
      {
        icon: 'box',
        name: 'رحلة يوكيدز',
        nameEn: 'UOKIDS journey',
        pain: 'عايزة تجهّزي مرة واحدة؟',
        painEn: 'Want to get it done in one go?',
        desc: 'من غير ما تفكري كل شهر في حاجة ناقصة: النوم والرضاعة والخروج واللعب — من أول يوم لحد ما يمشي.',
        descEn: 'You do not want to keep thinking every month about something missing. Everything from day one until he walks - sleep, feeding, outings and play.',
        items: ['كل حاجة من أول يوم', 'لعب يدعم حواسه وعضلاته', 'أوفر قرار في الستور'],
        itemsEn: ['Everything from day one', 'Play that supports his senses and muscles', 'The best value in the store'],
        productId: 'uokids-motherhood-journey',
        altProductId: 'uokids-first-year-bundle',
      },
    ],
  }),

  band('favorites', 'product_rail', {
    heading: 'الأكثر تفضيلًا',
    headingEn: 'Most loved',
    collection: 'best-seller',
    limit: 8,
    showDiscount: true,
    imageFit: 'contain',
    autoplay: true,
    speed: 'normal',
    buttonLabel: 'شاهدي الكل',
    buttonLabelEn: 'View all',
    buttonHref: collection('best-seller'),
    tone: 'plain',
    ...CART_LABEL,
  }),

  band('spotted', 'video_reels', {
    heading: 'شوفيها على الحقيقة',
    headingEn: 'See it in real life',
    subheading: 'منتجات UOKIDS أثناء الاستخدام',
    subheadingEn: 'UOKIDS products in use',
    tone: 'primary',
    items: [
      {
        video: `${MEDIA}/videos/c/vp/4e8312a0ec5a45e1b6e4b254c16c70e3/4e8312a0ec5a45e1b6e4b254c16c70e3.HD-1080p-7.2Mbps-77083540.mp4`,
        poster: `${MEDIA}/files/preview_images/4e8312a0ec5a45e1b6e4b254c16c70e3.thumbnail.0000000000_900x.jpg`,
        productId: 'on-the-go-mama',
      },
      {
        video: `${MEDIA}/videos/c/vp/080f52ef32a449259e1a425121e01f93/080f52ef32a449259e1a425121e01f93.HD-1080p-2.5Mbps-76904464.mp4`,
        poster: `${MEDIA}/files/preview_images/080f52ef32a449259e1a425121e01f93.thumbnail.0000000000_900x.jpg`,
        productId: 'baby-carrier',
      },
      {
        video: `${MEDIA}/videos/c/vp/fb4fb4535e344546b49d0e840b766b94/fb4fb4535e344546b49d0e840b766b94.HD-1080p-4.8Mbps-77084150.mp4`,
        poster: `${MEDIA}/files/preview_images/fb4fb4535e344546b49d0e840b766b94.thumbnail.0000000000_900x.jpg`,
        productId: 'cozy-care-bundle-circle',
      },
      {
        video: `${MEDIA}/videos/c/vp/ba3b0ed3f4c1483fa671c2a417936c60/ba3b0ed3f4c1483fa671c2a417936c60.HD-1080p-3.3Mbps-77084079.mp4`,
        poster: `${MEDIA}/files/preview_images/ba3b0ed3f4c1483fa671c2a417936c60.thumbnail.0000000000_900x.jpg`,
        productId: 'self-feeding-pillow',
      },
    ],
  }),

  band('just-landed', 'product_shelf', {
    heading: 'وصل حديثًا',
    headingEn: 'Just landed',
    subheading: 'أحدث المنتجات في UOKIDS',
    subheadingEn: 'The newest at UOKIDS',
    collection: 'new-arrivals',
    limit: 8,
    showDiscount: true,
    showSoldOut: true,
    imageFit: 'contain',
    buttonLabel: 'شاهدي كل الجديد',
    buttonLabelEn: 'View all new arrivals',
    buttonHref: collection('new-arrivals'),
    tone: 'secondary',
    ...CART_LABEL,
  }),

  band('all-products', 'product_cards', {
    heading: 'كل منتجات يوكيدز',
    headingEn: 'Shop all UOKIDS',
    subheading: 'اختيارات أكتر ليكي ولبيبيك — أضيفي اللي محتاجاه للسلة مباشرة.',
    subheadingEn: 'More everyday picks for you and your baby — add what you need straight to cart.',
    collection: 'all-products',
    limit: 8,
    columns: 4,
    showDiscount: true,
    buttonLabel: 'تسوّقي كل المنتجات',
    buttonLabelEn: 'Shop all products',
    buttonHref: collection('all-products'),
    tone: 'plain',
    ...CART_LABEL,
  }),

  band('lifestyle', 'image_banner', {
    image: file('70caebfc-9ad5-428a-bfda-65ad6cb46d23.png', 2600),
    mobileImage: file('cbf0257c-8f70-4b30-a671-8f0b43680add.png', 1100),
    alt: 'UOKIDS — راحة أكتر ليكي ولبيبيك',
    heading: 'راحة أكتر ليكي ولبيبيك',
    headingEn: 'More comfort for you and your baby',
    text: 'اختيارات عملية تخلي يومك أهدى من أول نوم البيبي لحد الخروجات.',
    textEn: 'Practical picks that make your day calmer, from baby sleep to outings.',
    buttonLabel: 'اكتشفي المجموعة',
    buttonLabelEn: 'Explore the collection',
    buttonHref: collection('sleep-comfort'),
    height: 490,
    heightTablet: 430,
    heightMobile: 390,
    wave: true,
  }),
];

/**
 * The store-wide look the template brings with it: the theme, the running
 * offers bar, the menu and the footer. The dashboard copies this into the
 * workspace's `themeSettings` when the template is applied to a store that
 * has no look of its own (WebsitePage's applyTemplateLook).
 */
const themeSettings = {
  storeTheme: 'uokids',
  header: {
    announcement: {
      enabled: true,
      marquee: true,
      text: '🚚 شحن مجاني للطلبات من 1500 جنيه',
      messages: ['🚚 شحن مجاني للطلبات من 1500 جنيه', '🎁 خصم 8% للطلبات من 3000 جنيه', '🔥 خصم 12% للطلبات من 4200 جنيه'],
    },
    menu: [
      { label: 'الصفحة الرئيسية', href: '/' },
      { label: 'تسوق', href: '/products' },
      { label: 'مجموعات البيبي الأساسية', href: collection('uokids-bundles') },
      { label: 'من نحن', href: '/about-us' },
      { label: 'تواصل معنا', href: '/contact' },
    ],
    logo: { size: 'lg' },
    show: { theme: false, language: false, trackOrder: false },
  },
  footer: {
    text: 'شارع الفيروز، الشيخ زايد · info@uokids.com · 01007591211',
    groups: [
      {
        title: 'الاقسام',
        links: [
          { label: 'وصل حديثًا', href: collection('new-arrivals') },
          { label: 'الأكثر مبيعاً', href: collection('best-seller') },
          { label: 'مستلزمات الرضاعة', href: collection('feeding-1') },
          { label: 'النوم والراحة', href: collection('sleep-comfort') },
          { label: 'الخروجات والتغيير', href: collection('travel-changing') },
          { label: 'ألعاب', href: collection('toys') },
          { label: 'باقات يوكيدز', href: collection('uokids-bundles') },
        ],
      },
      {
        title: 'المعلومات',
        links: [
          { label: 'سياسة الخصوصية', href: '/privacy-policy' },
          { label: 'سياسة الاسترجاع', href: '/refund-policy' },
          { label: 'سياسة الشحن', href: '/shipping-policy' },
          { label: 'الشروط والأحكام', href: '/terms-of-service' },
          { label: 'الأسئلة الشائعة', href: '/faq' },
          { label: 'دليل المقاسات والأعمار', href: '/size-chart' },
        ],
      },
      {
        title: 'روابط مفيده',
        links: [
          { label: 'تتبّعي طلبك', href: '/track' },
          { label: 'السلة', href: '/cart' },
        ],
      },
    ],
    social: [
      { platform: 'facebook', url: 'https://www.facebook.com/uokids' },
      { platform: 'instagram', url: 'https://www.instagram.com/uokids.store' },
      { platform: 'tiktok', url: 'https://www.tiktok.com/@uokidsofficial' },
    ],
    whatsapp: '201007591211',
  },
};

module.exports = {
  TEMPLATE_ID,
  VERSION_ID,
  template: {
    id: TEMPLATE_ID,
    name: 'يوكيدز — Uokids',
    category: 'kids',
    kind: 'store',
    tags: ['kids', 'baby', 'bundles'],
    primaryColor: PINK,
    thumbnailUrl: null,
  },
  version: {
    id: VERSION_ID,
    globalStyles: { primaryColor: PINK, mode: 'light', themeSettings },
    pages: [{ path: '/', title: 'الرئيسية', pageType: 'home', builderData: { version: 1, sections: home }, seo: {} }],
  },
};
