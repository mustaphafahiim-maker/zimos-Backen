'use strict';

/**
 * The test dropshipping provider: fixed, realistic answers with no network,
 * so import → order → stock sync can be exercised end to end. Available
 * outside production only (index.js). See README.md for the contract.
 */

const PRODUCTS = {
  'SBX-1001': {
    name: 'Wireless Earbuds (test supplier)',
    description: 'Bluetooth 5.3 earbuds with a charging case. Test product from the sandbox supplier.',
    images: [],
    variants: [
      { code: 'SBX-1001-BLK', options: { Color: 'Black' }, priceAmount: 45000, costAmount: 27000, stock: 40 },
      { code: 'SBX-1001-WHT', options: { Color: 'White' }, priceAmount: 45000, costAmount: 27000, stock: 25 },
    ],
  },
  'SBX-1002': {
    name: 'Stainless Water Bottle 750ml (test supplier)',
    description: 'Insulated bottle. Test product from the sandbox supplier.',
    images: [],
    variants: [{ code: 'SBX-1002', options: {}, priceAmount: 22000, costAmount: 12000, stock: 120 }],
  },
};

const notFound = (code) => {
  const err = new Error(`The test supplier has no product "${code}" (try SBX-1001 or SBX-1002)`);
  err.code = 'DROPSHIP_PRODUCT_NOT_FOUND';
  err.status = 404;
  return err;
};

module.exports = {
  code: 'sandbox',
  name: 'Test supplier',
  isTest: true,
  // What the connect form asks for. `secret: true` fields are sealed and never returned.
  credentialFields: [{ key: 'apiKey', label: { en: 'API key (any value)', ar: 'مفتاح API (أي قيمة)' }, secret: true, required: true }],

  async verifyCredentials(credentials) {
    if (!credentials || !String(credentials.apiKey || '').trim()) {
      const err = new Error('An API key is required');
      err.code = 'DROPSHIP_INVALID_CREDENTIALS';
      err.status = 422;
      throw err;
    }
    return { accountName: 'Sandbox supplier account' };
  },

  async importProduct(credentials, code) {
    const product = PRODUCTS[String(code).trim().toUpperCase()];
    if (!product) throw notFound(code);
    return { externalId: String(code).trim().toUpperCase(), currency: 'EGP', ...product };
  },

  async pushOrder(credentials, order) {
    // The same order always gets the same number: pushing twice is harmless.
    const digits = String(order.orderNumber || order.id).replace(/\D/g, '').slice(-6).padStart(6, '0');
    return { externalOrderId: `SBX-ORD-${digits}`, externalStatus: 'received' };
  },

  async syncStock(credentials, externalIds) {
    const out = [];
    for (const id of externalIds) {
      const product = PRODUCTS[id];
      if (!product) continue;
      for (const variant of product.variants) out.push({ externalId: id, code: variant.code, stock: variant.stock });
    }
    return out;
  },

  /**
   * Where a forwarded order stands. The test supplier moves on with time, so
   * following can be watched: confirmed after 1 minute, shipped after 3,
   * delivered after 6. A number ending in 0 is refused at the door (cancelled).
   */
  async getOrderStatus(credentials, externalOrderId, { pushedAt } = {}) {
    if (/0$/.test(String(externalOrderId))) return { externalStatus: 'cancelled' };
    const minutes = (Date.now() - new Date(pushedAt || Date.now()).getTime()) / 60000;
    const externalStatus = minutes >= 6 ? 'delivered' : minutes >= 3 ? 'shipped' : minutes >= 1 ? 'confirmed' : 'received';
    return { externalStatus };
  },

  /**
   * Optional (item 263): the supplier's shipping price for its lines to a
   * destination, minor units. The test supplier: 60 EGP to Cairo and Giza,
   * 75 elsewhere, plus 5 per item after the first.
   */
  async shippingQuote(credentials, { province, lines }) {
    const units = (lines || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    const base = /cairo|giza|القاهرة|الجيزة/i.test(String(province || '')) ? 6000 : 7500;
    return { amount: base + Math.max(0, units - 1) * 500, currency: 'EGP' };
  },

  /** Optional (item 263): the smallest order the supplier takes, in minor units of its lines. */
  async minimumOrder() {
    return { amount: 30000, currency: 'EGP' };
  },

  /** The provider's order status → the ZIMOS order stage it means (null = no change). */
  mapStatus(externalStatus) {
    return { received: null, confirmed: 'ready_to_ship', shipped: 'shipped', delivered: 'delivered', returned: 'returned', cancelled: 'cancelled' }[externalStatus] ?? null;
  },
};
