'use strict';

const { Router } = require('express');
const Joi = require('joi');
const multer = require('multer');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const { requireCreationAllowed } = require('../../../core/middleware/subscriptionGuard');
const { AppError, ValidationError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const { readSheet, SheetError } = require('./sheetReader');
const transfer = require('./productTransfer');

/*
 * Product import and export (SPEC §7.5, §7.10), mounted inside the catalog
 * router ahead of `/products/:productId`:
 *
 *   GET  /products/export.json          every product, as one JSON document
 *   GET  /products/import-template.csv  the sheet's columns with two example rows
 *   POST /products/import               a file (multipart `file`: .json, .csv,
 *                                       .xlsx) or a JSON body { url } with a
 *                                       Shopify product link → 202 { import }
 *   GET  /imports, /imports/:importId   progress and the error report
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

function acceptFile(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  return upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('FILE_TOO_LARGE', 'The file exceeds the 10MB limit', 413));
    }
    return next(err instanceof multer.MulterError ? new AppError('UPLOAD_ERROR', err.message, 422) : err);
  });
}

const router = Router({ mergeParams: true });
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);
const uuid = Joi.string().uuid();
const workspaceOnly = { params: Joi.object({ workspaceId: uuid.required() }) };

router.get(
  '/products/export.json',
  validate(workspaceOnly),
  canManage,
  asyncHandler(async (req, res) => {
    const document = await transfer.exportProducts(req.tenant.workspaceId);
    await recordAudit({
      workspaceId: req.tenant.workspaceId,
      actorUserId: req.user.id,
      action: 'product.export',
      entityType: 'Product',
      metadata: { products: document.products.length },
      req,
    });
    res.setHeader('Content-Disposition', `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(document);
  })
);

router.get(
  '/products/import-template.csv',
  validate(workspaceOnly),
  canView,
  asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="products-template.csv"');
    res.send(transfer.templateCsv());
  })
);

router.post(
  '/products/import',
  canManage,
  requireCreationAllowed,
  acceptFile,
  asyncHandler(async (req, res) => {
    let kind;
    let sourceName;
    let products;
    if (req.file) {
      sourceName = req.file.originalname;
      const looksJson = /\.json$/i.test(sourceName) || /json/.test(req.file.mimetype || '');
      if (looksJson) {
        kind = 'json';
        let body;
        try {
          body = JSON.parse(req.file.buffer.toString('utf8').replace(/^﻿/, ''));
        } catch (err) {
          throw new ValidationError([{ field: 'file', message: 'The file is not valid JSON' }]);
        }
        products = transfer.fromJson(body);
      } else {
        kind = 'sheet';
        try {
          products = transfer.fromSheet(readSheet(req.file.buffer, sourceName));
        } catch (err) {
          if (err instanceof SheetError) throw new ValidationError([{ field: 'file', message: err.message }]);
          throw err;
        }
        if (products.length === 0) throw new ValidationError([{ field: 'file', message: 'The sheet has no product rows' }]);
      }
    } else if (req.body && typeof req.body.url === 'string' && require('./importers').detect(req.body.url)) {
      // AliExpress, Etsy, CJ, YouCan (importers/README.md): the product and the reviews its page publishes.
      const out = await require('./importers').fromLink(req.body.url);
      kind = `${out.source}_link`;
      sourceName = req.body.url;
      products = out.products;
    } else if (req.body && typeof req.body.url === 'string') {
      kind = 'shopify_link';
      sourceName = req.body.url;
      products = await transfer.fromShopifyLink(req.body.url);
    } else if (req.body && Array.isArray(req.body.products)) {
      kind = 'json';
      sourceName = 'JSON';
      products = transfer.fromJson(req.body);
    } else {
      throw new ValidationError([{ field: 'file', message: 'Send a file (.json, .csv, .xlsx) or a product link' }]);
    }

    const created = await transfer.createImport(req.tenant.workspaceId, { kind, sourceName, products }, req.user.id);
    await recordAudit({
      workspaceId: req.tenant.workspaceId,
      actorUserId: req.user.id,
      action: 'product.import',
      entityType: 'CatalogImport',
      entityId: created.id,
      metadata: { kind, total: created.total },
      req,
    });
    res.status(202).json({ import: created });
  })
);

router.get(
  '/imports',
  validate(workspaceOnly),
  canView,
  asyncHandler(async (req, res) => {
    res.json({ imports: await transfer.listImports(req.tenant.workspaceId) });
  })
);

router.get(
  '/imports/:importId',
  validate({ params: Joi.object({ workspaceId: uuid.required(), importId: uuid.required() }) }),
  canView,
  asyncHandler(async (req, res) => {
    res.json({ import: await transfer.getImport(req.tenant.workspaceId, req.params.importId) });
  })
);

module.exports = router;
