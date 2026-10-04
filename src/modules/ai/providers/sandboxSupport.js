'use strict';

/**
 * The sandbox answer for `support_reply` (whatsapp/bot): fixed rules standing
 * in for a model, so the customer service bot can be tried end to end. It
 * reads only what the request carries — the customer's last message, the
 * store's facts, the products and the customer's own orders — and either
 * answers or hands the conversation to a person.
 */

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ْ]/g, '');

const has = (text, words) => words.some((w) => text.includes(norm(w)));

const HUMAN = ['موظف', 'حد يرد', 'حد يكلمني', 'خدمه العملاء', 'انسان', 'مدير', 'human', 'agent', 'representative', 'manager'];
const UPSET = ['نصب', 'حرامي', 'زفت', 'وحش', 'مش محترم', 'شكوي', 'scam', 'terrible', 'worst', 'angry', 'complaint'];
const DISCOUNT = ['خصم', 'تخفيض', 'ارخص', 'discount', 'cheaper', 'coupon'];
const ORDER = ['طلبي', 'الطلب', 'اوردر', 'الشحنه', 'وصل', 'امتي يوصل', 'تتبع', 'order', 'tracking', 'shipment', 'delivered'];
const PRICE = ['بكام', 'سعر', 'كام', 'السعر', 'price', 'cost', 'how much'];
const SHIPPING = ['شحن', 'توصيل', 'مصاريف', 'delivery', 'shipping'];
const RETURNS = ['مرتجع', 'استرجاع', 'استبدال', 'ارجاع', 'return', 'refund', 'exchange'];
const HELLO = ['اهلا', 'السلام', 'مرحبا', 'هاي', 'صباح', 'مساء', 'hi', 'hello', 'hey', 'good morning'];

const say = {
  ar: {
    handoff: 'حاضر، هحوّلك لحد من فريقنا يرد عليك في أقرب وقت.',
    noDiscount: 'الأسعار المعروضة هي أفضل سعر متاح حاليًا، ولو فيه عرض هيظهر على صفحة المنتج. تحب أحوّلك لحد من الفريق؟',
    noOrders: 'مش لاقي طلبات على رقمك ده. لو طلبت برقم تاني ابعتلي رقم الطلب وهحوّلك للفريق.',
    order: (o) => `طلبك رقم ${o.number}: ${o.status}.${o.total ? ` الإجمالي ${o.total}.` : ''}`,
    product: (p) => `${p.name}: ${p.price}${p.inStock ? ' — متوفر' : ' — غير متوفر حاليًا'}.`,
    prices: 'دي أسعار منتجاتنا:',
    welcome: (store) => `أهلًا بيك في ${store}! تقدر تسألني عن الأسعار أو الشحن أو حالة طلبك.`,
    unknown: 'سؤال حلو — هسأل الفريق وحد هيرد عليك قريب.',
    shippingDefault: 'بنوصّل لكل المحافظات والدفع عند الاستلام. تفاصيل الشحن بتظهر لك في صفحة الطلب قبل ما تأكد.',
    returnsDefault: 'تقدر ترجع أو تستبدل حسب سياسة الاسترجاع في المتجر. تحب أحوّلك لحد من الفريق؟',
  },
  en: {
    handoff: 'Sure — someone from our team will reply to you shortly.',
    noDiscount: 'The prices shown are the best we have right now; any offer appears on the product page. Shall I pass you to the team?',
    noOrders: "I can't find an order on this number. If you ordered with another number, send me the order number and I'll pass you to the team.",
    order: (o) => `Order ${o.number}: ${o.status}.${o.total ? ` Total ${o.total}.` : ''}`,
    product: (p) => `${p.name}: ${p.price}${p.inStock ? ' — in stock' : ' — out of stock for now'}.`,
    prices: 'Here are our prices:',
    welcome: (store) => `Welcome to ${store}! Ask me about prices, delivery or your order.`,
    unknown: "Good question — I'll ask the team and someone will reply soon.",
    shippingDefault: 'We deliver everywhere and you pay on delivery. The delivery cost shows on the order page before you confirm.',
    returnsDefault: "You can return or exchange as the store's return policy says. Shall I pass you to the team?",
  },
};

function supportReply({ input, context }) {
  const text = norm(input.message);
  const t = input.dialect === 'english' ? say.en : say.ar;
  const reply = (body) => ({ action: 'reply', text: body });
  const store = (context && context.store) || {};
  const products = (context && context.products) || [];
  const orders = (context && context.orders) || [];

  if (has(text, HUMAN) || has(text, UPSET)) return { action: 'handoff', text: t.handoff };
  // Never gives a discount on its own (SPEC §19.3 limits).
  if (has(text, DISCOUNT)) return reply(t.noDiscount);
  if (has(text, ORDER)) return orders.length ? reply(t.order(orders[0])) : reply(t.noOrders);

  const named = products.filter((p) => norm(p.name).split(/\s+/).some((word) => word.length > 2 && text.includes(word)));
  if (named.length) return reply(named.slice(0, 3).map(t.product).join('\n'));
  if (has(text, PRICE)) return products.length ? reply([t.prices, ...products.slice(0, 5).map(t.product)].join('\n')) : { action: 'handoff', text: t.unknown };
  if (has(text, SHIPPING)) return reply(store.shipping || store.extraInfo || t.shippingDefault);
  if (has(text, RETURNS)) return reply(store.returns || t.returnsDefault);
  if (has(text, HELLO)) return reply(t.welcome(store.name || ''));
  return { action: 'handoff', text: t.unknown };
}

module.exports = { supportReply };
