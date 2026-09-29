'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireCreationAllowed } = require('../../core/middleware/subscriptionGuard');
const controller = require('./catalogController');
const schemas = require('./catalogValidation');

const router = Router({ mergeParams: true });

router.use(authenticate, resolveTenant);

const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);

// --- Products ---------------------------------------------------------------
// A new product is refused while the store is restricted (unpaid past its
// grace day, or suspended); everything below keeps working.
router.post('/products', validate(schemas.product), canManage, requireCreationAllowed, controller.createProduct);
router.get('/products', validate(schemas.productList), canView, controller.listProducts);
router.get('/products/:productId', validate(schemas.productGet), canView, controller.getProduct);
router.patch('/products/:productId', validate(schemas.productUpdate), canManage, controller.updateProduct);
router.delete('/products/:productId', validate(schemas.productDelete), canManage, controller.deleteProduct);
router.post('/products/:productId/restore', validate(schemas.productRestore), canManage, controller.restoreProduct);
router.delete(
  '/products/:productId/permanent',
  validate(schemas.productDeletePermanent),
  canManage,
  controller.deleteProductPermanently
);

// --- Variants -------------------------------------------------------------
router.post('/products/:productId/variants', validate(schemas.variant), canManage, controller.createVariant);
router.get('/variants/:variantId', validate(schemas.variantGet), canView, controller.getVariant);
router.patch('/variants/:variantId', validate(schemas.variantUpdate), canManage, controller.updateVariant);
router.delete('/variants/:variantId', validate(schemas.variantDelete), canManage, controller.deleteVariant);

// --- Offers -------------------------------------------------------------
router.post('/products/:productId/offers', validate(schemas.offer), canManage, controller.createOffer);
router.get('/products/:productId/offers', validate(schemas.offerList), canView, controller.listOffers);
router.get('/offers/:offerId', validate(schemas.offerGet), canView, controller.getOffer);
router.patch('/offers/:offerId', validate(schemas.offerUpdate), canManage, controller.updateOffer);
router.delete('/offers/:offerId', validate(schemas.offerDelete), canManage, controller.deleteOffer);

// --- Collections -------------------------------------------------------------
router.post('/collections', validate(schemas.collection), canManage, controller.createCollection);
router.get('/collections', validate(schemas.collectionList), canView, controller.listCollections);
// The whole tree's parents and positions in one request (drag and drop).
router.post('/collections/reorder', validate(schemas.collectionReorder), canManage, controller.reorderCollections);
router.put(
  '/collections/:collectionId/products/order',
  validate(schemas.collectionProductOrder),
  canManage,
  controller.reorderCollectionProducts
);
// Option names in use ("Size", "Color"), for choosing storefront filters.
router.get('/option-names', validate(schemas.collectionList), canView, controller.listOptionNames);
router.get('/collections/:collectionId', validate(schemas.collectionGet), canView, controller.getCollection);
router.patch('/collections/:collectionId', validate(schemas.collectionUpdate), canManage, controller.updateCollection);
router.delete('/collections/:collectionId', validate(schemas.collectionDelete), canManage, controller.deleteCollection);
router.post(
  '/products/:productId/collections/:collectionId',
  validate(schemas.addToCollection),
  canManage,
  controller.addToCollection
);
router.delete(
  '/products/:productId/collections/:collectionId',
  validate(schemas.removeFromCollection),
  canManage,
  controller.removeFromCollection
);

module.exports = router;
