'use strict';

/**
 * Ready-made automations (SPEC §14.2), switched on with one click. Each is a
 * normal rule the merchant can edit afterwards.
 *
 * `template` in a whatsapp_template step is the *name of the message template
 * in the merchant's own WhatsApp account*: Meta only sends templates it has
 * approved for that account, so ZIMOS cannot ship the text itself. `whatsapp`
 * below is what the merchant should submit to Meta under that name — the
 * dashboard shows it next to the rule. Until it is approved the step fails
 * with Meta's own error in the run log.
 */

const TEMPLATES = [
  {
    key: 'order_confirmation',
    trigger: 'order.created',
    name: { ar: 'تأكيد الطلب عبر واتساب', en: 'Order confirmation on WhatsApp' },
    description: {
      ar: 'رسالة فورية عند إنشاء الطلب بزرّي "تأكيد الطلب" و"إلغاء". رد العميل يغيّر حالة الطلب تلقائيًا، وإذا لم يرد خلال ٦ ساعات يُنبَّه الفريق لتأكيده يدويًا.',
      en: 'An instant message with "Confirm order" and "Cancel" buttons. The reply changes the order automatically; with no reply in 6 hours the team is told to confirm by hand.',
    },
    conditions: { paymentMethod: 'cod' },
    steps: [
      { type: 'whatsapp_template', template: 'order_confirmation', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{order_total}}'] },
      { type: 'wait', amount: 6, unit: 'hours' },
      { type: 'notify_team', message: 'العميل {{customer_name}} لم يرد على رسالة تأكيد الطلب {{order_number}} — يحتاج تأكيدًا يدويًا.' },
    ],
    whatsapp: {
      name: 'order_confirmation',
      body: 'مرحبًا {{1}}، استلمنا طلبك رقم {{2}} بإجمالي {{3}}. من فضلك أكّد الطلب لنبدأ تجهيزه.',
      buttons: ['تأكيد الطلب', 'إلغاء'],
    },
  },
  {
    key: 'order_shipped',
    trigger: 'order.shipped',
    name: { ar: 'تم شحن الطلب', en: 'Order shipped' },
    description: { ar: 'رقم البوليصة ورابط التتبع فور تسليم الطلب لشركة الشحن.', en: 'Waybill number and tracking link as soon as the courier has the order.' },
    conditions: {},
    steps: [{ type: 'whatsapp_template', template: 'order_shipped', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{waybill_number}}', '{{order_link}}'] }],
    whatsapp: { name: 'order_shipped', body: 'مرحبًا {{1}}، تم شحن طلبك رقم {{2}}. رقم البوليصة: {{3}}. تابع الشحنة من هنا: {{4}}' },
  },
  {
    key: 'out_for_delivery',
    trigger: 'order.out_for_delivery',
    name: { ar: 'المندوب في الطريق', en: 'Courier on the way' },
    description: { ar: 'تنبيه للعميل ليجهّز المبلغ قبل وصول المندوب.', en: 'Tells the customer to have the amount ready before the courier arrives.' },
    conditions: {},
    steps: [{ type: 'whatsapp_template', template: 'out_for_delivery', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{order_total}}'] }],
    whatsapp: { name: 'out_for_delivery', body: 'مرحبًا {{1}}، المندوب في الطريق إليك بطلبك رقم {{2}}. من فضلك جهّز مبلغ {{3}}.' },
  },
  {
    key: 'delivered_review',
    trigger: 'order.delivered',
    name: { ar: 'تم التسليم + طلب تقييم', en: 'Delivered + review request' },
    description: { ar: 'رسالة شكر عند التسليم، ثم طلب تقييم المنتج بعد ٣ أيام.', en: 'A thank-you on delivery, then a review request 3 days later.' },
    conditions: { stopOnStatusChange: false },
    steps: [
      { type: 'whatsapp_template', template: 'order_delivered', language: 'ar', params: ['{{customer_name}}', '{{store_name}}'] },
      { type: 'wait', amount: 3, unit: 'days' },
      { type: 'whatsapp_template', template: 'review_request', language: 'ar', params: ['{{customer_name}}', '{{product_names}}', '{{review_link}}'] },
    ],
    whatsapp: { name: 'order_delivered', body: 'مرحبًا {{1}}، سعداء بوصول طلبك. شكرًا لثقتك في {{2}}.' },
    whatsappExtra: [{ name: 'review_request', body: 'مرحبًا {{1}}، نتمنى أن يكون {{2}} قد أعجبك. رأيك يهمنا: {{3}}' }],
  },
  {
    key: 'abandoned_cart',
    trigger: 'checkout.abandoned',
    name: { ar: 'استرجاع السلة المتروكة', en: 'Abandoned cart recovery' },
    // SPEC §6.4: WhatsApp after 30 minutes, then after 24 hours with a coupon. A checkout counts as
    // abandoned after 15 minutes by default (abandoned_after_minutes), so the first reminder waits 15 more.
    description: {
      ar: 'تذكير بعد حوالي نص ساعة من ترك الطلب، ثم تذكير أخير بعد يوم — بكود خصم لو حددته. يتوقف تلقائيًا إذا أكمل العميل الشراء.',
      en: 'A reminder about half an hour after the order was left, then a last one a day later — with a coupon when you give one. Stops by itself once the customer buys.',
    },
    conditions: {},
    steps: [
      { type: 'wait', amount: 15, unit: 'minutes' },
      { type: 'whatsapp_template', template: 'cart_reminder', language: 'ar', params: ['{{customer_name}}', '{{store_name}}', '{{recovery_link}}'] },
      { type: 'wait', amount: 1, unit: 'days' },
      { type: 'whatsapp_template', template: 'cart_reminder_last', language: 'ar', params: ['{{customer_name}}', '{{recovery_link}}'] },
    ],
    // Switched on with a coupon (POST …/templates/abandoned_cart/enable { couponCode }): the last reminder offers it,
    // and only its link applies it (recoveryCoupon.js).
    couponStep: {
      index: 3,
      step: { type: 'whatsapp_template', template: 'cart_reminder_coupon', language: 'ar', params: ['{{customer_name}}', '{{coupon_code}}', '{{recovery_link}}'] },
    },
    whatsapp: { name: 'cart_reminder', body: 'مرحبًا {{1}}، طلبك من {{2}} في انتظارك. أكمله من هنا: {{3}}\nللإيقاف أرسل: إيقاف' },
    whatsappExtra: [
      { name: 'cart_reminder_last', body: 'مرحبًا {{1}}، ما زال طلبك محفوظًا. أكمله الآن: {{2}}\nللإيقاف أرسل: إيقاف' },
      { name: 'cart_reminder_coupon', body: 'مرحبًا {{1}}، ما زال طلبك محفوظًا — استخدم الكود {{2}} واحصل على خصم. أكمله الآن: {{3}}\nللإيقاف أرسل: إيقاف' },
    ],
  },
  {
    key: 'payment_failed',
    trigger: 'order.payment_failed',
    name: { ar: 'فشل الدفع + رابط الدفع', en: 'Payment failed + payment link' },
    description: { ar: 'رسالة برابط الدفع عند فشل عملية الدفع الإلكتروني.', en: 'A message with the payment link when an online payment fails.' },
    conditions: {},
    // A short wait, inside the order's payment window (PAYMENT_ATTEMPT_TTL_MINUTES, 30 by default):
    // the shopper may simply try again first, and an order that expires meanwhile stops the run and
    // becomes a lost order with its own recovery.
    steps: [
      { type: 'wait', amount: 20, unit: 'minutes' },
      { type: 'whatsapp_template', template: 'payment_failed', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{payment_link}}'] },
    ],
    whatsapp: { name: 'payment_failed', body: 'مرحبًا {{1}}، لم تكتمل عملية الدفع لطلبك رقم {{2}}. أعد المحاولة من هنا: {{3}}' },
  },
  {
    key: 'transfer_rejected',
    trigger: 'order.transfer_rejected',
    name: { ar: 'رفض التحويل + رفع إيصال جديد', en: 'Transfer rejected + send a new receipt' },
    description: {
      ar: 'رسالة برابط الطلب عند رفض إيصال التحويل، ليرفع العميل إيصالًا جديدًا.',
      en: 'A message with the order link when a transfer receipt is rejected, so the customer can send a new one.',
    },
    conditions: {},
    steps: [
      { type: 'whatsapp_template', template: 'transfer_rejected', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{order_link}}'] },
    ],
    whatsapp: { name: 'transfer_rejected', body: 'مرحبًا {{1}}، لم نتمكن من تأكيد التحويل لطلبك رقم {{2}}. ارفع إيصالًا جديدًا من هنا: {{3}}' },
  },
  {
    key: 'digital_delivery',
    trigger: 'order.digital_delivered',
    name: { ar: 'تسليم المنتج الرقمي', en: 'Digital product delivery' },
    description: {
      ar: 'رابط التحميل على واتساب فور دفع طلب فيه منتج رقمي (SPEC §18.2). الرابط يفتح صفحة الطلب بروابط التحميل.',
      en: 'The download link on WhatsApp as soon as an order with a digital product is paid. The link opens the order page with its downloads.',
    },
    conditions: {},
    steps: [{ type: 'whatsapp_template', template: 'digital_delivery', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{order_link}}'] }],
    whatsapp: { name: 'digital_delivery', body: 'مرحبًا {{1}}، شكرًا لطلبك رقم {{2}}. مشترياتك الرقمية جاهزة للتحميل من هنا: {{3}}' },
  },
  {
    key: 'unreachable',
    trigger: 'order.unreachable',
    name: { ar: 'لم يرد على الاتصال', en: 'Did not answer the call' },
    description: { ar: 'رسالة "حاولنا التواصل معك" عندما لا يرد العميل على مكالمة التأكيد.', en: '"We tried to reach you" when the customer does not answer the confirmation call.' },
    conditions: {},
    steps: [{ type: 'whatsapp_template', template: 'tried_to_reach', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{store_name}}'] }],
    whatsapp: { name: 'tried_to_reach', body: 'مرحبًا {{1}}، حاولنا التواصل معك لتأكيد طلبك رقم {{2}} من {{3}} ولم نتمكن. من فضلك رد على هذه الرسالة لتأكيد الطلب.' },
  },
  {
    key: 'subscription_renewal_failed',
    trigger: 'subscription.renewal_failed',
    name: { ar: 'فشل تجديد الاشتراك + تحديث البطاقة', en: 'Renewal failed + update the card' },
    description: {
      ar: 'عند تعذّر سحب تجديد اشتراك أو قسط: رسالة واتساب وبريد برابط صفحة الاشتراك، حيث يغيّر العميل بطاقته فيُسحب التجديد فورًا. يُعاد السحب تلقائيًا بعد ١ ثم ٣ ثم ٧ أيام قبل الإلغاء.',
      en: 'When a subscription or installment renewal cannot be charged: a WhatsApp message and an email with the subscription page, where the customer changes their card and the renewal is charged at once. The charge is retried after 1, 3 and 7 days before it is cancelled.',
    },
    conditions: {},
    steps: [
      { type: 'whatsapp_template', template: 'subscription_renewal_failed', language: 'ar', params: ['{{customer_name}}', '{{product_name}}', '{{payment_link}}'] },
      {
        type: 'email',
        subject: 'تعذّر تجديد اشتراكك في {{product_name}}',
        body: 'مرحبًا {{customer_name}}،\n\nلم نتمكن من سحب قيمة تجديد اشتراكك في {{product_name}} ({{order_total}}). حدّث بطاقتك من هنا ليستمر اشتراكك:\n{{payment_link}}\n\n{{store_name}}',
      },
    ],
    whatsapp: { name: 'subscription_renewal_failed', body: 'مرحبًا {{1}}، تعذّر سحب قيمة تجديد اشتراكك في {{2}}. حدّث بطاقتك من هنا ليستمر الاشتراك: {{3}}' },
  },
];

const byKey = (key) => TEMPLATES.find((t) => t.key === key) || null;

/** What the dashboard lists. */
const publicView = (t) => ({
  key: t.key,
  trigger: t.trigger,
  name: t.name,
  description: t.description,
  conditions: t.conditions,
  steps: t.steps,
  // Takes a coupon when switched on (its last message then offers it).
  acceptsCoupon: Boolean(t.couponStep),
  whatsappTemplates: [t.whatsapp, ...(t.whatsappExtra || [])].filter(Boolean),
});

/** The rule a template becomes: with `couponCode`, a template that offers one uses its coupon step. */
function ruleFrom(t, couponCode) {
  if (!couponCode || !t.couponStep) return { conditions: t.conditions, steps: t.steps };
  const steps = t.steps.map((s, i) => (i === t.couponStep.index ? t.couponStep.step : s));
  return { conditions: { ...t.conditions, couponCode }, steps };
}

module.exports = { TEMPLATES, byKey, publicView, ruleFrom };
