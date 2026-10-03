'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const env = require('../../config/env');
const c = require('./contactController');
const s = require('./contactValidation');

// Contacts, segments and form submissions (SPEC §18.4).
// Mounted at /api/v1/workspaces/:workspaceId/contacts
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);

staff.get('/', validate(s.list), requirePermission(P.CUSTOMERS_VIEW), c.list);
staff.post('/', validate(s.create), requirePermission(P.CUSTOMERS_MANAGE), c.create);
staff.get('/export', validate(s.exportCsv), requirePermission(P.CUSTOMERS_REVEAL_SENSITIVE), c.exportCsv);
staff.get('/tags', validate(s.workspaceOnly), requirePermission(P.CUSTOMERS_VIEW), c.listTags);
staff.post('/bulk-tag', validate(s.bulkTag), requirePermission(P.CUSTOMERS_MANAGE), c.bulkTag);

staff.get('/segments', validate(s.workspaceOnly), requirePermission(P.CUSTOMERS_VIEW), c.listSegments);
staff.post('/segments', validate(s.createSegment), requirePermission(P.CUSTOMERS_MANAGE), c.createSegment);
staff.post('/segments/preview', validate(s.previewSegment), requirePermission(P.CUSTOMERS_VIEW), c.previewSegment);
staff.patch('/segments/:segmentId', validate(s.updateSegment), requirePermission(P.CUSTOMERS_MANAGE), c.updateSegment);
staff.delete('/segments/:segmentId', validate(s.segment), requirePermission(P.CUSTOMERS_MANAGE), c.deleteSegment);

staff.get('/forms', validate(s.listForms), requirePermission(P.FORM_SUBMISSIONS_VIEW), c.listForms);
staff.patch('/forms/:submissionId', validate(s.markForm), requirePermission(P.FORM_SUBMISSIONS_VIEW), c.markForm);
staff.delete('/forms/:submissionId', validate(s.form), requirePermission(P.CUSTOMERS_MANAGE), c.deleteForm);

staff.get('/:customerId', validate(s.get), requirePermission(P.CUSTOMERS_VIEW), c.get);
staff.put('/:customerId/tags', validate(s.setTags), requirePermission(P.CUSTOMERS_MANAGE), c.setTags);

// Public: a shopper submits a page form. No staff auth.
// Mounted at /api/v1/store/:workspaceId/forms
const store = Router({ mergeParams: true });
const formLimiter = createIpMinuteLimiter('store-forms', 6, { skip: () => env.isTest });
store.post('/', formLimiter, resolvePublicWorkspace, validate(s.submitForm), c.submitForm);

module.exports = { staff, store };
