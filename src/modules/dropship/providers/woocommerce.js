'use strict';

const { storeOrigin, call, err } = require('./storeHttp');

/*
 * Send orders to the merchant's own WooCommerce store and follow them there
 * (spec-gaps item 181), on the dropship provider contract (README.md).
 * Credentials: the store address and a REST API consumer key + secret
 * (WooCommerce → Settings → Advanced → REST API, read/write).
 *
 * Products imported from it carry "<productId>" or "<productId>:<variationId>"
 * as their SKU, which maps a line back to the Woo product; a line that maps
 * to nothing is refused (Woo orders need a product). The pushed order keeps
 * the ZIMOS order id in its meta (`_zimos_order_id`) so a second push finds it.
 */

const base = (c) => `${storeOrigin(c.storeUrl)}/wp-json/wc/v3`;
const auth = (c) => ({ authorization: `Basic ${Buffer.from(`${c.consumerKey || ''}:${c.consumerSecret || ''}`).toString('base64')}` });
const minor = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const major = (m) => (Number(m || 0) / 100).toFixed(2);

function person(order) {
  const a = order.shippingAddress || {};
  const c = order.contact || {};
  const [first, ...rest] = String(c.fullName || '').trim().split(/\s+/);
  return { first_name: first || '', last_name: rest.join(' '), address_1: a.addressLine || '', address_2: a.area || '', city: a.city || '', state: a.province || '', postcode: a.postalCode || '', country: a.country || 'EG', phone: c.phone || '' };
}

module.exports = {
  code: 'woocommerce',
  name: 'WooCommerce store',
  isTest: false,
  credentialFields: [
    { key: 'storeUrl', label: { en: 'Store address (https://mystore.com)', ar: 'عنوان المتجر (https://mystore.com)' }, secret: false, required: true },
    { key: 'consumerKey', label: { en: 'Consumer key', ar: 'Consumer key' }, secret: true, required: true },
    { key: 'consumerSecret', label: { en: 'Consumer secret', ar: 'Consumer secret' }, secret: true, required: true },
  ],

  async verifyCredentials(c) {
    const json = await call('GET', `${base(c)}/orders?per_page=1`, { headers: auth(c) });
    if (!Array.isArray(json)) throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store did not answer as a WooCommerce store');
    return { accountName: new URL(storeOrigin(c.storeUrl)).host };
  },

  async importProduct(c, code) {
    const id = String(code).split(':')[0].replace(/\D/g, '');
    const p = await call('GET', `${base(c)}/products/${id}`, { headers: auth(c) });
    const variations = p.type === 'variable' ? await call('GET', `${base(c)}/products/${id}/variations?per_page=100`, { headers: auth(c) }) : [];
    const variants = variations.length
      ? variations.map((v) => ({ code: `${p.id}:${v.id}`, options: Object.fromEntries((v.attributes || []).map((a) => [a.name, a.option])), priceAmount: minor(v.price), costAmount: null, stock: Number(v.stock_quantity) || 0 }))
      : [{ code: String(p.id), options: {}, priceAmount: minor(p.price), costAmount: null, stock: Number(p.stock_quantity) || 0 }];
    return { externalId: String(p.id), name: p.name, description: p.description || '', images: (p.images || []).map((i) => i.src).filter(Boolean), currency: null, variants };
  },

  async pushOrder(c, order) {
    const recent = await call('GET', `${base(c)}/orders?per_page=50&orderby=date&order=desc`, { headers: auth(c) });
    const found = (recent || []).find((o) => (o.meta_data || []).some((m) => m.key === '_zimos_order_id' && m.value === order.id));
    if (found) return { externalOrderId: String(found.id), externalStatus: found.status };
    const lines = (order.items || []).map((i) => {
      const [productId, variationId] = String(i.sku || '').split(':');
      if (!/^\d+$/.test(productId || '')) throw err('DROPSHIP_ORDER_REJECTED', 409, `"${i.name}" is not a product of the WooCommerce store`);
      return { product_id: Number(productId), ...(variationId ? { variation_id: Number(variationId) } : {}), quantity: i.quantity, total: major(i.lineTotal) };
    });
    const who = person(order);
    const body = {
      payment_method: order.paymentMethod === 'cod' ? 'cod' : 'other',
      payment_method_title: order.paymentMethod === 'cod' ? 'Cash on delivery' : 'Paid on Zimos',
      set_paid: order.paymentMethod !== 'cod',
      status: 'processing',
      currency: order.currency,
      billing: { ...who, email: (order.contact || {}).email || '' },
      shipping: who,
      line_items: lines,
      shipping_lines: Number((order.amounts || {}).shipping) ? [{ method_id: 'flat_rate', method_title: 'Shipping', total: major(order.amounts.shipping) }] : [],
      customer_note: order.notes || '',
      meta_data: [{ key: '_zimos_order_id', value: order.id }, { key: '_zimos_order_number', value: order.orderNumber }],
    };
    const created = await call('POST', `${base(c)}/orders`, { headers: auth(c), body });
    return { externalOrderId: String(created.id), externalStatus: created.status };
  },

  async syncStock(c, externalIds) {
    const out = [];
    for (const id of externalIds) {
      const p = await call('GET', `${base(c)}/products/${encodeURIComponent(id)}`, { headers: auth(c) }).catch(() => null);
      if (!p) continue;
      if (p.type === 'variable') {
        const vs = await call('GET', `${base(c)}/products/${p.id}/variations?per_page=100`, { headers: auth(c) }).catch(() => []);
        for (const v of vs) out.push({ externalId: String(p.id), code: `${p.id}:${v.id}`, stock: Number(v.stock_quantity) || 0 });
      } else out.push({ externalId: String(p.id), code: String(p.id), stock: Number(p.stock_quantity) || 0 });
    }
    return out;
  },

  async getOrderStatus(c, externalOrderId) {
    const o = await call('GET', `${base(c)}/orders/${encodeURIComponent(externalOrderId)}`, { headers: auth(c) });
    return { externalStatus: o.status };
  },

  // WooCommerce: pending, processing, on-hold, completed, cancelled, refunded, failed.
  mapStatus(s) {
    return { pending: null, processing: null, 'on-hold': null, completed: 'shipped', cancelled: 'cancelled', refunded: 'returned', failed: 'cancelled' }[s] ?? null;
  },
};
