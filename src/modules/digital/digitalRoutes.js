'use strict';
const { Router } = require('express');
const Joi = require('joi');
const multer = require('multer');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const { AppError } = require('../../core/errors/AppError');
const env = require('../../config/env');
const service = require('./digitalService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const wsId = (req) => req.tenant.workspaceId;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: service.MAX_FILE_BYTES, files: 1 } });
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('FILE_TOO_LARGE', 'The file is larger than 100 MB', 413));
      return next(new AppError('UPLOAD_ERROR', err.message, 422));
    }
    return next(err);
  });
}

const deliveryBody = Joi.object({
  type: Joi.string().valid(...service.TYPES).required(),
  fileId: uuid.allow(null),
  linkUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000).allow(null, '').when('type', { is: 'link', then: Joi.required().invalid(null, '') }),
  message: Joi.string().max(2000).allow(null, ''),
  maxDownloads: Joi.number().integer().min(1).max(1000).allow(null),
  linkValidHours: Joi.number().integer().min(1).max(24 * 365 * 5).allow(null),
  isActive: Joi.boolean().default(true),
});

// Digital products (SPEC §18.2). Mounted at /api/v1/workspaces/:workspaceId/digital
// The plan's file storage limit, once the file's size is known (billing/limitGuards.js).
const { requireStorageRoom } = require('../billing/limitGuards');
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const view = requirePermission(P.PRODUCTS_VIEW);
const manage = requirePermission(P.PRODUCTS_MANAGE);

staff.get('/files', validate({ params: Joi.object(ws) }), view, asyncHandler(async (req, res) => res.json(await service.listFiles(wsId(req)))));
staff.post('/files', manage, acceptFile, requireStorageRoom(), asyncHandler(async (req, res) => res.status(201).json({ file: await service.uploadFile(wsId(req), req.file, req) })));
// Large files, uploaded in parts straight to storage (multipartUploads.js).
staff.use('/files/multipart', require('./multipartUploads').router);
staff.delete(
  '/files/:fileId',
  validate({ params: Joi.object({ ...ws, fileId: uuid.required() }) }),
  manage,
  asyncHandler(async (req, res) => {
    await service.deleteFile(wsId(req), req.params.fileId, req);
    res.status(204).end();
  })
);

staff.get('/products', validate({ params: Joi.object(ws) }), view, asyncHandler(async (req, res) => res.json(await service.listProducts(wsId(req)))));
const productParams = Joi.object({ ...ws, productId: uuid.required() });
staff.get(
  '/products/:productId/delivery',
  validate({ params: productParams }),
  view,
  asyncHandler(async (req, res) => res.json(await service.getDelivery(wsId(req), req.params.productId)))
);
staff.put(
  '/products/:productId/delivery',
  validate({ params: productParams, body: deliveryBody }),
  manage,
  asyncHandler(async (req, res) => res.json(await service.saveDelivery(wsId(req), req.params.productId, req.body, req)))
);
staff.get(
  '/products/:productId/codes',
  validate({
    params: productParams,
    query: Joi.object({ status: Joi.string().valid('available', 'assigned'), limit: Joi.number().integer().min(1).max(500).default(100) }),
  }),
  view,
  asyncHandler(async (req, res) => res.json(await service.listCodes(wsId(req), req.params.productId, req.query)))
);
staff.post(
  '/products/:productId/codes',
  validate({ params: productParams, body: Joi.object({ codes: Joi.string().min(1).max(500000).required() }) }),
  manage,
  asyncHandler(async (req, res) => res.status(201).json(await service.addCodes(wsId(req), req.params.productId, req.body.codes, req)))
);
staff.delete(
  '/codes/:codeId',
  validate({ params: Joi.object({ ...ws, codeId: uuid.required() }) }),
  manage,
  asyncHandler(async (req, res) => {
    await service.deleteCode(wsId(req), req.params.codeId, req);
    res.status(204).end();
  })
);

const orderParams = Joi.object({ ...ws, orderId: uuid.required() });
staff.get(
  '/orders/:orderId/grants',
  validate({ params: orderParams }),
  requirePermission(P.ORDERS_VIEW),
  asyncHandler(async (req, res) => res.json(await service.listOrderGrants(wsId(req), req.params.orderId)))
);
staff.post(
  '/orders/:orderId/deliver',
  validate({ params: orderParams }),
  requirePermission(P.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json(await service.deliverOrder(wsId(req), req.params.orderId, req)))
);
staff.post(
  '/grants/:grantId',
  validate({ params: Joi.object({ ...ws, grantId: uuid.required() }), body: Joi.object({ action: Joi.string().valid('renew', 'revoke').required() }) }),
  requirePermission(P.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json({ grant: await service.updateGrant(wsId(req), req.params.grantId, req.body, req) }))
);

// Public: the buyer's download link. The token is the credential.
// Mounted at /api/v1/store/:workspaceId/downloads
const store = Router({ mergeParams: true });
const downloadLimiter = createIpMinuteLimiter('store-downloads', 30, { skip: () => env.isTest });
store.use(downloadLimiter, resolvePublicWorkspace);
// The thank-you page: an online order's download links, for the shopper who
// holds its payment token (x-payment-token, as GET /orders/:id/payment). Empty
// until the payment is captured; the page asks again until they appear.
store.get(
  '/order/:orderId',
  // The store may be named by id or slug (resolvePublicWorkspace); the order only by id.
  validate({ params: Joi.object({ workspaceId: Joi.string().max(100).required(), orderId: uuid.required() }) }),
  asyncHandler(async (req, res) => {
    const order = await require('../payments/onlinePaymentService').loadOrderForShopper(wsId(req), req.params.orderId, req.headers['x-payment-token']);
    res.set('Cache-Control', 'private, no-store');
    res.json({ downloads: await service.publicGrantsForOrder(wsId(req), order.id) });
  })
);
store.get('/:token', asyncHandler(async (req, res) => res.json(await service.getPublicGrant(wsId(req), req.params.token))));
store.get(
  '/:token/file',
  asyncHandler(async (req, res) => {
    const file = await service.downloadFile(wsId(req), req.params.token);
    // A large file is fetched from storage itself, through a short-lived signed link.
    if (file.redirect) {
      res.set('Cache-Control', 'private, no-store');
      return res.redirect(302, file.redirect);
    }
    res.set('Content-Type', file.mimeType || 'application/octet-stream');
    res.set('Content-Length', String(file.buffer.length));
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    // Always a download, never rendered in the store's origin.
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.send(file.buffer);
  })
);

module.exports = { staff, store };
