'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const { formatAmount } = require('../../automations/automationContext');

/**
 * Taking a cash-on-delivery order in the chat (SPEC §19.3 "can create a COD
 * order after confirming the details with the customer"). A guided form, one
 * question at a time, kept in whatsapp_conversations.bot_state, so every
 * detail is the customer's own words and the order is only placed after they
 * confirm the summary — whatever the AI provider is.
 *
 *   product → (option) → quantity → name → governorate → city → address → confirm
 *
 * "إلغاء" / "cancel" stops it at any step; a flow left for 2 hours starts over.
 * The order is a normal storefront COD order (prices, shipping, stock and the
 * fraud rules as on the website), tagged "whatsapp-bot".
 */

const STALE_MS = 2 * 60 * 60 * 1000;
const MAX_QTY = 10;
const ORDER_TAG = 'whatsapp-bot';

const norm = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

const START = ['عايز اطلب', 'عاوز اطلب', 'اريد ان اطلب', 'ابغي اطلب', 'اطلب', 'احجز', 'اشتري', 'i want to order', 'place an order', 'order now', 'buy'];
const CANCEL = ['الغاء', 'الغي', 'cancel', 'stop'];
const YES = ['تاكيد', 'اكد', 'ايوه', 'نعم', 'تمام', 'موافق', 'yes', 'confirm', 'ok'];

const has = (text, words) => words.some((w) => text.includes(norm(w)));
const numberIn = (text) => {
  const m = norm(text).match(/\d+/);
  return m ? Number(m[0]) : null;
};

const T = {
  ar: {
    pick: 'تمام! اختار المنتج — ابعت رقمه:',
    none: 'للأسف مفيش منتجات متاحة للطلب دلوقتي.',
    option: 'اختار النوع — ابعت رقمه:',
    qty: `كام قطعة؟ (من 1 لـ ${MAX_QTY})`,
    name: 'اسمك بالكامل؟',
    province: 'في أنهي محافظة؟',
    city: 'المدينة أو المنطقة؟',
    address: 'العنوان بالتفصيل (الشارع ورقم العمارة وأي علامة مميزة)؟',
    summary: (s) =>
      [
        'راجع طلبك:',
        `${s.productName}${s.optionLabel ? ` (${s.optionLabel})` : ''} × ${s.quantity}`,
        `المنتجات: ${s.subtotal}`,
        `الشحن: ${s.shipping}`,
        ...(s.tax ? [`الضريبة: ${s.tax}`] : []),
        `الإجمالي عند الاستلام: ${s.total}`,
        `الاسم: ${s.name}`,
        `العنوان: ${s.street}، ${s.city}، ${s.province}`,
        'اكتب «تأكيد» لتأكيد الطلب أو «إلغاء» للإلغاء.',
      ].join('\n'),
    placed: (n) => `تم تسجيل طلبك رقم ${n} ✅ هنتواصل معاك لتأكيده قبل الشحن.`,
    cancelled: 'تمام، لغيت الطلب. لو احتجت أي حاجة أنا هنا.',
    again: 'مش فاهم الرد ده — ',
    failed: 'معرفتش أسجّل الطلب دلوقتي، هحوّلك لحد من الفريق يكمّل معاك.',
  },
  en: {
    pick: 'Great! Choose a product — send its number:',
    none: 'Sorry, nothing can be ordered right now.',
    option: 'Choose the option — send its number:',
    qty: `How many? (1 to ${MAX_QTY})`,
    name: 'Your full name?',
    province: 'Which governorate?',
    city: 'City or area?',
    address: 'Your full address (street, building, a landmark)?',
    summary: (s) =>
      [
        'Please check your order:',
        `${s.productName}${s.optionLabel ? ` (${s.optionLabel})` : ''} × ${s.quantity}`,
        `Items: ${s.subtotal}`,
        `Delivery: ${s.shipping}`,
        ...(s.tax ? [`Tax: ${s.tax}`] : []),
        `Total, paid on delivery: ${s.total}`,
        `Name: ${s.name}`,
        `Address: ${s.street}, ${s.city}, ${s.province}`,
        'Reply "confirm" to place it or "cancel".',
      ].join('\n'),
    placed: (n) => `Your order ${n} is placed ✅ We'll contact you to confirm it before shipping.`,
    cancelled: 'OK, the order is cancelled. I am here if you need anything.',
    again: "I didn't get that — ",
    failed: "I couldn't place the order right now; someone from the team will help you.",
  },
};

async function products(workspaceId) {
  return db.sequelize.query(
    `SELECT p.id, p.name,
            json_agg(json_build_object('id', v.id, 'options', v.option_values, 'price', v.price_amount, 'currency', v.currency)
                     ORDER BY v.price_amount) AS variants
       FROM products p JOIN product_variants v ON v.product_id = p.id
      WHERE p.workspace_id = :workspaceId AND p.status = 'active' AND v.status = 'active'
        AND (v.allow_overselling OR v.stock_on_hand - v.reserved_stock > 0)
      GROUP BY p.id, p.name ORDER BY MAX(p.updated_at) DESC LIMIT 9`,
    { replacements: { workspaceId }, type: QueryTypes.SELECT }
  );
}

const optionLabel = (options) =>
  options && typeof options === 'object' ? Object.values(options).filter(Boolean).join(' / ') : '';

const numbered = (rows, label) => rows.map((row, i) => `${i + 1}. ${label(row)}`).join('\n');

/**
 * Whether this message belongs to the order flow, and the reply if so:
 * `{ text, handoff? }`, or null when the bot should answer it as a question.
 */
async function handle({ workspace, conversation, message, lang }) {
  const t = T[lang] || T.ar;
  const text = norm(message);
  let state = conversation.botState && conversation.botState.order ? { ...conversation.botState.order } : null;
  if (state && Date.now() - new Date(state.at || 0).getTime() > STALE_MS) state = null;
  const save = (next) => conversation.update({ botState: next ? { order: { ...next, at: new Date().toISOString() } } : {} });

  if (!state) {
    if (!has(text, START) || has(text, ['طلبي', 'my order'])) return null;
    const list = await products(workspace.id);
    if (list.length === 0) return { text: t.none };
    await save({ step: 'product', choices: list.map((p) => p.id) });
    return { text: `${t.pick}\n${numbered(list, (p) => `${p.name} — ${formatAmount(p.variants[0].price, p.variants[0].currency)}`)}` };
  }

  if (has(text, CANCEL)) {
    await save(null);
    return { text: t.cancelled };
  }

  const ask = async (step, extra, reply) => {
    await save({ ...state, ...extra, step });
    return { text: reply };
  };

  switch (state.step) {
    case 'product': {
      const n = numberIn(text);
      const list = await products(workspace.id);
      const product = n && list.find((p) => p.id === state.choices[n - 1]);
      if (!product) return { text: `${t.again}${t.pick}\n${numbered(list, (p) => p.name)}` };
      if (product.variants.length > 1) {
        return ask('option', { productId: product.id, productName: product.name, variantChoices: product.variants.map((v) => v.id) }, `${t.option}\n${numbered(product.variants, (v) => `${optionLabel(v.options) || '—'} — ${formatAmount(v.price, v.currency)}`)}`);
      }
      return ask('quantity', { productId: product.id, productName: product.name, variantId: product.variants[0].id }, t.qty);
    }
    case 'option': {
      const n = numberIn(text);
      const variantId = n && state.variantChoices[n - 1];
      if (!variantId) return { text: `${t.again}${t.option}` };
      const variant = await db.ProductVariant.findOne({ where: { id: variantId, workspaceId: workspace.id }, attributes: ['optionValues'] });
      return ask('quantity', { variantId, optionLabel: optionLabel(variant && variant.optionValues) }, t.qty);
    }
    case 'quantity': {
      const n = numberIn(text);
      if (!n || n < 1 || n > MAX_QTY) return { text: `${t.again}${t.qty}` };
      return ask('name', { quantity: n }, t.name);
    }
    case 'name':
      if (message.trim().length < 3) return { text: `${t.again}${t.name}` };
      return ask('province', { name: message.trim().slice(0, 100) }, t.province);
    case 'province':
      if (message.trim().length < 2) return { text: `${t.again}${t.province}` };
      return ask('city', { province: message.trim().slice(0, 100) }, t.city);
    case 'city':
      if (message.trim().length < 2) return { text: `${t.again}${t.city}` };
      return ask('street', { city: message.trim().slice(0, 100) }, t.address);
    case 'street': {
      if (message.trim().length < 5) return { text: `${t.again}${t.address}` };
      const street = message.trim().slice(0, 300);
      const quote = await require('../../shipping/shippingQuoteService').quote(workspace.id, {
        country: 'EG',
        region: state.province,
        items: [{ variantId: state.variantId, quantity: state.quantity }],
      });
      // Tax as the order will charge it (tax/taxService), so the total the customer confirms is the real one.
      const { taxAmount } = await require('../../tax/taxService').calculateTax(workspace.id, {
        country: 'EG',
        region: state.province,
        lines: [{ productId: state.productId, lineTotal: quote.subtotal }],
        shippingAmount: quote.amount,
      });
      const fmt = (amount) => formatAmount(amount, quote.currency);
      const total = Number(quote.subtotal) + Number(quote.amount) + Number(taxAmount || 0);
      const summary = { ...state, street, subtotal: fmt(quote.subtotal), shipping: fmt(quote.amount), tax: Number(taxAmount) > 0 ? fmt(taxAmount) : null, total: fmt(total) };
      return ask('confirm', { street }, t.summary(summary));
    }
    case 'confirm': {
      if (!has(text, YES)) return { text: `${t.again}${lang === 'en' ? 'reply "confirm" or "cancel".' : 'اكتب «تأكيد» أو «إلغاء».'}` };
      try {
        const { order } = await require('../../orders/orderService').createOrder(
          workspace.id,
          {
            items: [{ variantId: state.variantId, quantity: state.quantity }],
            contact: { fullName: state.name, phone: conversation.phoneNormalized },
            shippingAddress: { country: 'EG', province: state.province, city: state.city, addressLine: state.street },
            paymentMethod: 'cod',
            notes: lang === 'en' ? 'Placed in the WhatsApp chat with the store bot.' : 'اتسجّل من محادثة واتساب مع بوت المتجر.',
          },
          // As a shopper on the website: the store's prices, shipping, stock and fraud rules apply.
          { user: null, headers: { 'user-agent': 'zimos-whatsapp-bot' }, ip: null },
          { source: 'store' }
        );
        await order.update({ tags: [...new Set([...(order.tags || []), ORDER_TAG])] });
        await save(null);
        return { text: t.placed(order.orderNumber), orderId: order.id };
      } catch (err) {
        await save(null);
        return { text: t.failed, handoff: true, error: err.message };
      }
    }
    default:
      await save(null);
      return null;
  }
}

module.exports = { handle, ORDER_TAG };
