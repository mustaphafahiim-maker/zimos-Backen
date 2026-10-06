'use strict';

const { storeOrigin, call, err } = require('./storeHttp');

/*
 * Send orders to the merchant's own Shopify store and follow their
 * fulfilment there (spec-gaps item 181), on the dropship provider contract
 * (README.md). Credentials: the store address and an Admin API access token
 * of a custom app with read/write orders and read products scopes.
 *
 * Products imported from it carry the Shopify variant id as their SKU, so an
 * order's lines map back to Shopify variants; any other line goes as a
 * custom line (title, price, SKU). Each pushed order is tagged and carries
 * `source_identifier` = the ZIMOS order id, so a second push finds it.
 */

const VERSION = '2024-10';
const base = (c) => `${storeOrigin(c.storeUrl)}/admin/api/${VERSION}`;
const auth = (c) => ({ 'X-Shopify-Access-Token': String(c.accessToken || '') });
const minor = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const major = (m) => (Number(m || 0) / 100).toFixed(2);

function address(order) {
  const a = order.shippingAddress || {};
  const c = order.contact || {};
  const [first, ...rest] = String(c.fullName || '').trim().split(/\s+/);
  return {
    first_name: first || '', last_name: rest.join(' ') || '', phone: c.phone || null,
    address1: a.addressLine || '', address2: a.area || '', city: a.city || '', province: a.province || '', zip: a.postalCode || '', country_code: a.country || 'EG',
  };
}

module.exports = {
  code: 'shopify',
  name: 'Shopify store',
  isTest: false,
  credentialFields: [
    { key: 'storeUrl', label: { en: 'Store address (mystore.myshopify.com)', ar: 'عنوان المتجر (mystore.myshopify.com)' }, secret: false, required: true },
    { key: 'accessToken', label: { en: 'Admin API access token', ar: 'توكن Admin API' }, secret: true, required: true },
  ],

  async verifyCredentials(c) {
    const json = await call('GET', `${base(c)}/shop.json`, { headers: auth(c) });
    if (!json || !json.shop) throw err('DROPSHIP_INVALID_CREDENTIALS', 422, 'The store did not answer as a Shopify store');
    return { accountName: json.shop.name || json.shop.domain };
  },

  async importProduct(c, code) {
    const json = await call('GET', `${base(c)}/products/${encodeURIComponent(String(code).replace(/\D/g, ''))}.json`, { headers: auth(c) });
    const p = json && json.product;
    if (!p) throw err('DROPSHIP_PRODUCT_NOT_FOUND', 404, `No product ${code} in the Shopify store`);
    const options = (p.options || []).filter((o) => o.name !== 'Title');
    return {
      externalId: String(p.id), name: p.title, description: p.body_html || '',
      images: (p.images || []).map((i) => i.src).filter(Boolean), currency: null,
      variants: (p.variants || []).map((v) => ({
        code: String(v.id),
        options: Object.fromEntries(options.map((o, i) => [o.name, v[`option${i + 1}`]]).filter(([, val]) => val)),
        priceAmount: minor(v.price), costAmount: null, stock: Number(v.inventory_quantity) || 0,
      })),
    };
  },

  async pushOrder(c, order) {
    // Safe twice: an order already sent (same source_identifier) is answered as it is.
    const since = new Date(new Date(order.createdAt || Date.now()).getTime() - 864e5).toISOString();
    const existing = await call('GET', `${base(c)}/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}&fields=id,source_identifier,fulfillment_status,cancelled_at`, { headers: auth(c) });
    const found = ((existing && existing.orders) || []).find((o) => o.source_identifier === `zimos-${order.id}`);
    if (found) return { externalOrderId: String(found.id), externalStatus: statusOf(found) };
    const lines = (order.items || []).map((i) =>
      /^\d+$/.test(String(i.sku || ''))
        ? { variant_id: Number(i.sku), quantity: i.quantity, price: major(i.unitPrice) }
        : { title: i.name, quantity: i.quantity, price: major(i.unitPrice), sku: i.sku || undefined, requires_shipping: true }
    );
    const addr = address(order);
    const body = {
      order: {
        line_items: lines,
        financial_status: order.paymentMethod === 'cod' ? 'pending' : 'paid',
        currency: order.currency,
        shipping_address: addr, billing_address: addr,
        phone: (order.contact || {}).phone || undefined,
        email: (order.contact || {}).email || undefined,
        note: [`Zimos order ${order.orderNumber}`, order.notes].filter(Boolean).join('\n'),
        tags: 'zimos',
        source_identifier: `zimos-${order.id}`,
        send_receipt: false, send_fulfillment_receipt: false,
        inventory_behaviour: 'decrement_obeying_policy',
        shipping_lines: Number((order.amounts || {}).shipping) ? [{ title: 'Shipping', price: major(order.amounts.shipping) }] : [],
      },
    };
    const json = await call('POST', `${base(c)}/orders.json`, { headers: auth(c), body });
    return { externalOrderId: String(json.order.id), externalStatus: statusOf(json.order) };
  },

  async syncStock(c, externalIds) {
    const out = [];
    for (const id of externalIds) {
      const json = await call('GET', `${base(c)}/products/${encodeURIComponent(id)}.json?fields=id,variants`, { headers: auth(c) }).catch(() => null);
      for (const v of (json && json.product && json.product.variants) || []) out.push({ externalId: String(id), code: String(v.id), stock: Number(v.inventory_quantity) || 0 });
    }
    return out;
  },

  async getOrderStatus(c, externalOrderId) {
    const json = await call('GET', `${base(c)}/orders/${encodeURIComponent(externalOrderId)}.json?fields=id,fulfillment_status,cancelled_at,fulfillments`, { headers: auth(c) });
    const o = json.order;
    const f = (o.fulfillments || []).slice(-1)[0];
    return {
      externalStatus: statusOf(o),
      ...(f && f.tracking_number ? { tracking: { company: f.tracking_company || null, number: f.tracking_number, url: f.tracking_url || null } } : {}),
    };
  },

  mapStatus(s) {
    return { open: null, partial: null, fulfilled: 'shipped', delivered: 'delivered', cancelled: 'cancelled' }[s] ?? null;
  },
};

// Shopify's order → one status word: cancelled, fulfilled (shipped), partial, open.
function statusOf(o) {
  if (o.cancelled_at) return 'cancelled';
  const f = (o.fulfillments || []).slice(-1)[0];
  if (f && f.shipment_status === 'delivered') return 'delivered';
  if (o.fulfillment_status === 'fulfilled') return 'fulfilled';
  if (o.fulfillment_status === 'partial') return 'partial';
  return 'open';
}
