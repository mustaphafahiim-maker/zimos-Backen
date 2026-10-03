'use strict';

/**
 * The sandbox AI provider: fixed, realistic answers with no network call, so
 * every AI feature can be used end to end before a real provider is chosen
 * (SPEC §0, §19). It reads the input only to echo the product's own name and
 * language back; it invents nothing about the product.
 *
 * Contract: ../README.md.
 */

const AR = (dialect) => dialect !== 'english' && dialect !== 'french';

function product({ input }) {
  const name = String(input.name).trim();
  const ar = AR(input.dialect);
  return ar
    ? {
        name,
        description: `${name} — نص تجريبي من مزوّد الاختبار. اكتب هنا وصف المنتج الحقيقي: ما هو، لمن، وما المشكلة التي يحلها.\n\nهذه مسودة: راجعها وعدّلها قبل النشر.`,
        features: [
          { title: 'الميزة الأولى', description: 'اشرح في جملة واحدة أهم ما يميّز المنتج.' },
          { title: 'الميزة الثانية', description: 'اذكر الخامة أو المقاس أو طريقة الاستخدام.' },
          { title: 'الميزة الثالثة', description: 'وضّح ما الذي يحصل عليه العميل داخل العبوة.' },
        ],
        faqs: [
          { question: 'كم يستغرق التوصيل؟', answer: 'اكتب مدة التوصيل الفعلية لمتجرك.' },
          { question: 'هل يمكن الإرجاع؟', answer: 'اكتب سياسة الإرجاع الفعلية لمتجرك.' },
          { question: 'ما طرق الدفع المتاحة؟', answer: 'اكتب طرق الدفع التي يقبلها متجرك.' },
        ],
        metaDescription: `${name} — مسودة وصف قصير لمحركات البحث.`.slice(0, 160),
        slug: 'sandbox-product',
        specialOfferText: '',
      }
    : {
        name,
        description: `${name} — sample text from the test provider. Write the real description here: what it is, who it is for and what problem it solves.\n\nThis is a draft: review and edit it before publishing.`,
        features: [
          { title: 'First feature', description: 'One sentence on what makes the product stand out.' },
          { title: 'Second feature', description: 'Material, size or how it is used.' },
          { title: 'Third feature', description: 'What the customer finds in the box.' },
        ],
        faqs: [
          { question: 'How long does delivery take?', answer: 'Write your store’s real delivery time.' },
          { question: 'Can I return it?', answer: 'Write your store’s real return policy.' },
          { question: 'How can I pay?', answer: 'Write the payment methods your store accepts.' },
        ],
        metaDescription: `${name} — draft search description.`.slice(0, 160),
        slug: 'sandbox-product',
        specialOfferText: '',
      };
}

function page({ input, context }) {
  const p = context.product;
  const ar = AR(input.dialect);
  let n = 0;
  const id = (prefix) => `${prefix}-${++n}`;
  const section = (...elements) => ({
    id: id('s'),
    type: 'section',
    rows: [{ id: id('r'), type: 'row', columns: [{ id: id('c'), type: 'column', span: 12, elements }] }],
  });
  const el = (type, props) => ({ id: id('e'), type, props });
  const buy = ar ? 'اطلب الآن' : 'Order now';
  const href = `/products/${p.slug}`;

  const sections = [
    section(
      el('heading', { text: p.name, level: 1 }),
      el('text', { text: p.description || (ar ? 'اكتب هنا جملة تشرح المنتج.' : 'One sentence that explains the product.') }),
      ...(p.imageUrl ? [el('image', { src: p.imageUrl, alt: p.name })] : []),
      el('button', { label: buy, href })
    ),
    section(
      el('heading', { text: ar ? 'المشكلة والحل' : 'The problem and the fix', level: 2 }),
      el('text', { text: ar ? 'اكتب المشكلة التي يواجهها عميلك، ثم كيف يحلها المنتج.' : 'Describe the problem your customer has, then how the product solves it.' })
    ),
  ];
  if (p.features.length) {
    sections.push(section(el('heading', { text: ar ? 'المميزات' : 'Features', level: 2 }), el('list', { items: p.features.map((f) => f.title) })));
  }
  if (input.template !== 'short') {
    sections.push(
      section(
        el('heading', { text: ar ? 'الضمان' : 'Guarantee', level: 2 }),
        el('text', { text: ar ? 'اكتب هنا سياسة الضمان أو الإرجاع الفعلية لمتجرك.' : 'Write your store’s real guarantee or return policy here.' })
      )
    );
    if (p.faqs.length) {
      sections.push(section(el('heading', { text: ar ? 'أسئلة شائعة' : 'Questions', level: 2 }), el('faq', { items: p.faqs.map((f) => ({ q: f.question, a: f.answer })) })));
    }
  }
  sections.push(section(el('product_card', { productId: p.id, showPrice: true, showBuyButton: true }), el('button', { label: buy, href })));

  return { title: p.name, tree: { version: 1, sections } };
}

function translate({ input }) {
  const fields = {};
  for (const [key, value] of Object.entries(input.fields)) fields[key] = value ? `[${input.targetLanguage}] ${value}` : '';
  return { fields };
}

function policies({ input }) {
  const ar = AR(input.dialect);
  const store = input.storeName || (ar ? '[اسم المتجر]' : '[store name]');
  const delivery = input.deliveryDays || '[ ... ]';
  const returns = input.returnDays || '[ ... ]';
  const contact = input.contact || '[ ... ]';
  return ar
    ? {
        shipping: `يشحن ${store} الطلبات خلال ${delivery} يوم عمل من تأكيد الطلب.\nتُحسب تكلفة الشحن عند إتمام الطلب حسب المحافظة.\nللاستفسار عن شحنتك: ${contact}.`,
        returns: `يمكنك طلب إرجاع المنتج خلال ${returns} يوم من الاستلام بشرط أن يكون بحالته الأصلية.\nلبدء الإرجاع تواصل معنا: ${contact}.\nيُرد المبلغ بنفس طريقة الدفع بعد استلام المنتج وفحصه.`,
        privacy: `يجمع ${store} البيانات اللازمة لتنفيذ طلبك فقط: الاسم، رقم الهاتف، العنوان.\nلا نبيع بياناتك ولا نشاركها إلا مع شركة الشحن وبوابة الدفع لتنفيذ الطلب.\nلطلب تعديل بياناتك أو حذفها: ${contact}.`,
      }
    : {
        shipping: `${store} ships orders within ${delivery} business days of confirmation.\nShipping is priced at checkout by region.\nQuestions about a parcel: ${contact}.`,
        returns: `You can ask to return a product within ${returns} days of delivery, in its original condition.\nTo start a return, contact us: ${contact}.\nRefunds go back to the original payment method once the product is received and checked.`,
        privacy: `${store} collects only what is needed to fulfil your order: name, phone and address.\nWe never sell your data, and share it only with the courier and the payment gateway to complete the order.\nTo correct or delete your data: ${contact}.`,
      };
}

const HANDLERS = { product, page, translate, policies };

module.exports = {
  name: 'sandbox',
  isSandbox: () => true,
  async generate(request) {
    const handler = HANDLERS[request.feature];
    if (!handler) {
      const err = new Error(`The sandbox provider has no answer for "${request.feature}"`);
      err.permanent = true;
      throw err;
    }
    const output = handler(request);
    return {
      output,
      usage: { tokensIn: Math.ceil(request.prompt.length / 4), tokensOut: Math.ceil(JSON.stringify(output).length / 4), costMicros: 0, costCurrency: null },
    };
  },
};
