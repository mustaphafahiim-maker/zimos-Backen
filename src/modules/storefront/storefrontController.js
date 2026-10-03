'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./storefrontService');
const db = require('../../db/models');
const shippingQuoteService = require('../shipping/shippingQuoteService');
const cartService = require('../cart/cartService');
const { AppError } = require('../../core/errors/AppError');

// One legal policy, variables filled in (storefront/storeInfo.js); 404 when not written.
const getPolicy = asyncHandler(async (req, res) =>
  res.json({ policy: require('./storeInfo').publicLegalPolicy(req.publicWorkspace, req.params.key) })
);
// Every public path of the store, for the storefront's sitemap.xml.
const getSitemap = asyncHandler(async (req, res) =>
  res.json({ entries: await require('./generalSettings').storeSitemap(req.publicWorkspace) })
);
const getStore = asyncHandler(async (req, res) => res.json({ store: await service.getStorefront(req.tenant.workspaceId) }));
// Products and collections come back in the shopper's language when the store
// has it translated (X-Store-Locale; modules/translations) — originals otherwise.
const i18n = require('../translations/translations');
const plain = (row) => (row && typeof row.toJSON === 'function' ? row.toJSON() : row);
const listProducts = asyncHandler(async (req, res) => {
  const result = await service.listProducts(req.tenant.workspaceId, req.query);
  if (result && Array.isArray(result.products)) await i18n.localizeProducts(req, result.products);
  res.json(result);
});
const getProduct = asyncHandler(async (req, res) => {
  const product = await service.getProductBySlugOrId(req.tenant.workspaceId, req.params.idOrSlug);
  await i18n.localizeProducts(req, [product]);
  res.json({ product });
});
const listCollections = asyncHandler(async (req, res) => {
  const collections = (await service.listCollections(req.tenant.workspaceId)).map(plain);
  res.json({ collections: await i18n.localizeCollections(req, collections) });
});
const suggestProducts = asyncHandler(async (req, res) =>
  res.json(await service.suggestProducts(req.tenant.workspaceId, req.query.q))
);
const getCollection = asyncHandler(async (req, res) => {
  const collection = plain(await service.getCollection(req.tenant.workspaceId, req.params.collectionId));
  await i18n.localizeCollections(req, [collection]);
  res.json({ collection });
});
// The signed tracking link (…/track?t=<token>): the same answer, no phone number needed.
const trackOrderByToken = asyncHandler(async (req, res) => res.json({ result: await service.trackOrderByToken(req.tenant.workspaceId, req.query.token) }));

// Always 200, with `result: null` when nothing matches — see service.trackOrder.
const trackOrder = asyncHandler(async (req, res) => res.json({ result: await service.trackOrder(req.tenant.workspaceId, req.query.phone, req.query.number) }));

// Items from the body, or the cart an X-Cart-Token names — the same two ways
// into checkout, except here the body's items win (the storefront may quote a
// Buy Now item while a cart exists).
const shippingQuote = asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  let items = req.body.items;
  if (!items) {
    const cartToken = req.headers['x-cart-token'];
    if (!cartToken) {
      throw new AppError('CART_TOKEN_OR_ITEM_REQUIRED', 'Send `items` in the body or an X-Cart-Token header', 400);
    }
    const cart = await db.Cart.findOne({ where: { workspaceId, guestToken: cartToken, status: 'active' } });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(workspaceId, cart.id));
  }
  const quote = await shippingQuoteService.quote(workspaceId, {
    country: req.body.country,
    region: req.body.governorate,
    items,
  });
  res.json({ quote });
});

module.exports = {
  getStore,
  getPolicy,
  getSitemap,
  listProducts,
  getProduct,
  suggestProducts,
  listCollections,
  getCollection,
  trackOrder,
  trackOrderByToken,
  shippingQuote,
};
