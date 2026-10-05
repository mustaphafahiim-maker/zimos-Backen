'use strict';

const fs = require('fs');
const path = require('path');
const Joi = require('joi');
const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const { formatAmount: formatMoney } = require('../../automations/automationContext');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../../orders/orderStage');
const { resolveStoreInfo } = require('../../storefront/storeInfo');

/**
 * What the bot knows and how it asks the AI provider (feature `support_reply`,
 * contract in modules/ai/README.md). Facts only: the store's own policies and
 * the merchant's extra information, the active products with price and stock,
 * and this customer's own orders found by their WhatsApp number. The answer
 * is checked against OUTPUT before anything is sent.
 */

const PROMPT = fs.readFileSync(path.join(__dirname, '../../ai/prompts/support_reply.v1.md'), 'utf8');
const OUTPUT = Joi.object({ action: Joi.string().valid('reply', 'handoff').required(), text: Joi.string().trim().min(1).max(1000).required() });

const DIALECT_NAME = { egyptian: 'Egyptian Arabic', gulf: 'Gulf Arabic', msa: 'Modern Standard Arabic', english: 'English', french: 'French' };

const STAGE_TEXT = {
  ar: {
    awaiting_payment: 'في انتظار الدفع',
    pending_confirmation: 'وصلنا وهنأكده معاك قريب',
    needs_follow_up: 'بنتابعه معاك',
    ready_to_ship: 'اتأكد وبيتجهز للشحن',
    shipped: 'اتشحن',
    out_for_delivery: 'مع المندوب في الطريق ليك',
    delivery_failed: 'المندوب ماقدرش يوصله، هنتواصل معاك',
    delivered: 'اتوصّل',
    returned: 'رجع',
    cancelled: 'اتلغى',
  },
  en: {
    awaiting_payment: 'waiting for payment',
    pending_confirmation: 'received, we will confirm it with you soon',
    needs_follow_up: 'we are following it up with you',
    ready_to_ship: 'confirmed and being prepared',
    shipped: 'shipped',
    out_for_delivery: 'out for delivery',
    delivery_failed: 'the courier could not deliver it, we will contact you',
    delivered: 'delivered',
    returned: 'returned',
    cancelled: 'cancelled',
  },
};

const cardText = (card) => [card.title, ...card.points].filter(Boolean).join(' — ');

async function contextFor(workspace, settings, conversation) {
  const lang = settings.dialect === 'english' ? 'en' : 'ar';
  const info = resolveStoreInfo(workspace.settings);
  const [products, orders] = await Promise.all([
    db.sequelize.query(
      `SELECT p.name, MIN(v.price_amount) AS price, SUM(GREATEST(v.stock_on_hand - v.reserved_stock, 0)) AS stock, BOOL_OR(v.allow_overselling) AS untracked
         FROM products p JOIN product_variants v ON v.product_id = p.id
        WHERE p.workspace_id = :workspaceId AND p.status = 'active' AND v.status = 'active'
        GROUP BY p.id, p.name ORDER BY MAX(p.updated_at) DESC LIMIT 30`,
      { replacements: { workspaceId: workspace.id }, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT o.order_number AS number, o.total_amount AS total, o.currency, ${STAGE_SQL} AS stage
         FROM ${ORDERS_WITH_STAGE_FROM}
         JOIN customers c ON c.id = o.customer_id
        WHERE o.workspace_id = :workspaceId AND c.phone_normalized = :phone AND o.is_test = false
        ORDER BY o.created_at DESC LIMIT 3`,
      { replacements: { workspaceId: workspace.id, phone: conversation.phoneNormalized }, type: QueryTypes.SELECT }
    ),
  ]);
  return {
    store: {
      name: workspace.name,
      extraInfo: settings.extraInfo || '',
      shipping: info.shipping_policy.enabled ? cardText(info.shipping_policy) : '',
      returns: info.return_policy.enabled ? cardText(info.return_policy) : '',
      cod: info.cod_policy.enabled ? cardText(info.cod_policy) : '',
    },
    products: products.map((p) => ({
      name: p.name,
      price: formatMoney(Number(p.price), workspace.defaultCurrency || 'EGP'),
      inStock: p.untracked === true || Number(p.stock) > 0,
    })),
    orders: orders.map((o) => ({ number: o.number, status: STAGE_TEXT[lang][o.stage] || o.stage, total: formatMoney(Number(o.total), o.currency) })),
  };
}

/** The bot's answer to the customer's latest message: { action: 'reply' | 'handoff', text }. */
async function answer({ workspace, settings, conversation, message, history = [] }) {
  // eslint-disable-next-line global-require
  const provider = require('../../ai/providers').getProvider();
  const context = await contextFor(workspace, settings, conversation);
  const lines = (list) => (list.length ? list.join('\n') : '—');
  const prompt = PROMPT.replace('{{store}}', workspace.name)
    .replace('{{dialect}}', DIALECT_NAME[settings.dialect] || DIALECT_NAME.egyptian)
    .replace('{{facts}}', lines([context.store.extraInfo, context.store.shipping, context.store.returns, context.store.cod].filter(Boolean)))
    .replace('{{products}}', lines(context.products.map((p) => `${p.name} — ${p.price} — ${p.inStock ? 'in stock' : 'out of stock'}`)))
    .replace('{{orders}}', lines(context.orders.map((o) => `${o.number} — ${o.status} — ${o.total}`)))
    .replace('{{history}}', lines(history.map((m) => `${m.direction === 'in' ? 'Customer' : 'Store'}: ${m.body || ''}`)))
    .replace('{{message}}', message);

  const { output } = await provider.generate({
    feature: 'support_reply',
    prompt,
    promptVersion: 'support_reply.v1',
    input: { message, dialect: settings.dialect },
    context,
    workspaceId: workspace.id,
    jobId: null,
  });
  const { error, value } = OUTPUT.validate(output || {}, { stripUnknown: true });
  if (error) {
    const err = new Error(`The AI provider's support reply was not usable: ${error.message}`);
    err.permanent = true;
    throw err;
  }
  return value;
}

module.exports = { answer, contextFor };
