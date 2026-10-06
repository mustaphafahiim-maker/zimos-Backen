'use strict';

/**
 * The app store's catalogue (SPEC §16.6). An "app" is either a feature of
 * ZIMOS a store switches on, or an integration with an outside party.
 *
 *   availability  available    can be installed now
 *                 coming_soon  the real adapter is the integrations team's
 *                              work; shown so the merchant knows it is planned
 *   openPath      where "Open" takes the merchant in the dashboard
 *   sandbox       only where test integrations are allowed (not production)
 *   standard      a feature every store has had: on until the store uninstalls
 *                 it (appGate.js); any other app is off until installed
 *
 * No prices here: an app costs what its `apps` row says (price_amount), set
 * by the platform admin once pricing is decided. Null = free.
 */

const CATEGORIES = [
  { key: 'tracking', name: { en: 'Tracking', ar: 'التتبع' } },
  { key: 'sales', name: { en: 'Sales optimisation', ar: 'زيادة المبيعات' } },
  { key: 'dropshipping', name: { en: 'Dropshipping', ar: 'الدروبشيبنج' } },
  { key: 'orders', name: { en: 'Order management', ar: 'إدارة الطلبات' } },
  { key: 'protection', name: { en: 'Protection', ar: 'الحماية' } },
  { key: 'seo', name: { en: 'SEO', ar: 'محركات البحث' } },
  { key: 'marketing', name: { en: 'Marketing', ar: 'التسويق' } },
  { key: 'store', name: { en: 'Store management', ar: 'إدارة المتجر' } },
];

const app = (key, category, kind, name, description, extra = {}) => ({ key, category, kind, name, description, availability: 'available', ...extra });
const soon = { availability: 'coming_soon' };

const APPS = [
  app('tracking_pixels', 'tracking', 'feature', { en: 'Tracking tools', ar: 'أدوات التتبع' }, { en: 'Meta, TikTok, Snapchat and Google pixels with server-side events.', ar: 'بيكسلات ميتا وتيك توك وسناب وجوجل مع أحداث من السيرفر.' }, { openPath: '/marketing', standard: true }),
  app('webhooks', 'orders', 'feature', { en: 'Webhooks', ar: 'الـ Webhooks' }, { en: 'Send orders and store events to your own systems as they happen.', ar: 'ابعت الطلبات وأحداث المتجر لأنظمتك أول ما تحصل.' }, { openPath: '/settings', standard: true }),
  app('public_api', 'orders', 'feature', { en: 'Public API', ar: 'الـ API العام' }, { en: 'API keys for your developers and partners.', ar: 'مفاتيح API للمطورين والشركاء.' }, { openPath: '/settings', standard: true }),
  app('whatsapp', 'marketing', 'feature', { en: 'WhatsApp', ar: 'واتساب' }, { en: 'Official WhatsApp: inbox, order messages and automations.', ar: 'واتساب الرسمي: صندوق الرسائل ورسائل الطلبات والأتمتة.' }, { openPath: '/automations', standard: true }),
  app('fraud_protection', 'protection', 'feature', { en: 'Fake-order protection', ar: 'الحماية من الطلبات الوهمية' }, { en: 'Rules, blocklist and risk scoring before an order is accepted.', ar: 'قواعد وقائمة حظر وتقييم مخاطر قبل قبول الطلب.' }, { openPath: '/fraud', standard: true }),
  app('offers', 'sales', 'feature', { en: 'Offers and bundles', ar: 'العروض والباقات' }, { en: 'Quantity offers, order bumps and upsells.', ar: 'عروض الكميات والإضافات والـ upsell.' }, { openPath: '/offers', standard: true }),
  app('dropship_sandbox', 'dropshipping', 'integration', { en: 'Test supplier', ar: 'مورّد تجريبي' }, { en: 'A test dropshipping supplier: import a product, forward an order and sync stock without a real account.', ar: 'مورّد دروبشيبنج تجريبي: استورد منتج وابعت طلب وحدّث المخزون من غير حساب حقيقي.' }, { openPath: '/apps/dropship_sandbox', sandbox: true }),
  app('taager', 'dropshipping', 'integration', { en: 'Taager', ar: 'تاجر' }, { en: 'Import Taager products and forward orders to them.', ar: 'استورد منتجات تاجر وابعت لهم الطلبات.' }, soon),
  app('shopify', 'store', 'integration', { en: 'Shopify', ar: 'شوبيفاي' }, { en: 'Import products and push orders to a Shopify store.', ar: 'استورد المنتجات وابعت الطلبات لمتجر شوبيفاي.' }, soon),
  app('woocommerce', 'store', 'integration', { en: 'WooCommerce', ar: 'ووكومرس' }, { en: 'Import products and receive orders from WordPress.', ar: 'استورد المنتجات واستقبل الطلبات من ووردبريس.' }, soon),
  app('google_sheets', 'orders', 'integration', { en: 'Google Sheets', ar: 'جوجل شيتس' }, { en: 'Orders, lost orders and leads written to your sheets as they happen.', ar: 'الطلبات والطلبات الضايعة والعملاء المحتملين يتكتبوا في شيتاتك أول ما يحصلوا.' }, { openPath: '/apps/google-sheets' }),
  // The store's product feed for Google (offers/productFeed.js): Merchant Center fetches it by URL.
  app('google_merchant', 'seo', 'integration', { en: 'Google Merchant', ar: 'جوجل ميرشانت' }, { en: 'A product feed for Google Shopping, with a checklist of what Merchant Center needs.', ar: 'ملف منتجات لجوجل شوبنج، مع قائمة بما يحتاجه Merchant Center.' }, { openPath: '/offers/feed', standard: true }),
  // A Clarity project id among the tracking pixels (marketing/trackingPixelService.js) loads its script in the store.
  app('clarity', 'tracking', 'integration', { en: 'Microsoft Clarity', ar: 'مايكروسوفت كلاريتي' }, { en: 'Session recordings and heatmaps: add your Clarity project id under Tracking tools.', ar: 'تسجيل الجلسات وخرائط الحرارة: أضف معرّف مشروع كلاريتي في أدوات التتبع.' }, { openPath: '/marketing', standard: true }),
  // Contacts with marketing consent to a list (emailMarketing/, item 182).
  app('mailchimp', 'marketing', 'integration', { en: 'Mailchimp', ar: 'ميل شيمب' }, { en: 'Send contacts who agreed to marketing to a Mailchimp audience, with tags.', ar: 'ابعت العملاء اللي وافقوا على التسويق لقائمة في ميل شيمب، بالتاجات.' }, { openPath: '/apps/email-marketing' }),
  app('klaviyo', 'marketing', 'integration', { en: 'Klaviyo', ar: 'كلافيو' }, { en: 'Send contacts who agreed to marketing to a Klaviyo list.', ar: 'ابعت العملاء اللي وافقوا على التسويق لقائمة في كلافيو.' }, { openPath: '/apps/email-marketing' }),
];

const BY_KEY = new Map(APPS.map((entry) => [entry.key, entry]));

module.exports = { CATEGORIES, APPS, BY_KEY };
