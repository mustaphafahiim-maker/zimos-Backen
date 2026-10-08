'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const payments = require('./paymentController');
const schemas = require('./billingValidation');

// Mounted at /api/v1/admin. The ways merchants pay (billing/paymentMethodService)
// and the transfer proofs waiting for review (billing/paymentProofService).
// Reading both is for whoever records payments; turning methods on and off
// and a manual method's number are separate keys, the creator's by default.
// `authenticate` is on each route, not router.use: this router shares the
// /admin prefix, and every other /admin request passes through it.
const router = Router();
const allow = (permission) => [authenticate, can(permission)];

router.get('/payment-methods', ...allow(P.PAYMENTS_RECORD), payments.adminListPaymentMethods);
router.put('/payment-methods/order', ...allow(P.PAYMENT_METHODS_MANAGE), validate(schemas.adminReorderPaymentMethods), payments.adminReorderPaymentMethods);
router.patch('/payment-methods/:code', ...allow(P.PAYMENT_METHODS_MANAGE), validate(schemas.adminUpdatePaymentMethod), payments.adminUpdatePaymentMethod);
router.patch(
  '/payment-methods/:code/account',
  ...allow(P.PAYMENT_METHODS_EDIT_NUMBERS),
  validate(schemas.adminUpdatePaymentMethodAccount),
  payments.adminUpdatePaymentMethodAccount
);

// A store's prepaid balance and its ledger (billing/walletService).
router.get(
  '/workspaces/:workspaceId/wallet',
  ...allow(P.SUBSCRIPTIONS_VIEW),
  validate(schemas.adminWorkspaceWallet),
  payments.adminWorkspaceWallet
);
// Free orders granted to one store, and a balance corrected by hand: each
// with a reason, audited, once per requestId.
router.post(
  '/workspaces/:workspaceId/wallet/free-orders',
  ...allow(P.SUBSCRIPTIONS_MANAGE),
  validate(schemas.adminGrantFreeOrders),
  payments.adminGrantFreeOrders
);
router.post(
  '/workspaces/:workspaceId/wallet/adjustments',
  ...allow(P.PAYMENTS_RECORD),
  validate(schemas.adminAdjustWallet),
  payments.adminAdjustWallet
);

router.get('/payment-proofs', ...allow(P.PAYMENTS_RECORD), validate(schemas.adminListProofs), payments.adminListProofs);
router.get('/payment-proofs/:proofId', ...allow(P.PAYMENTS_RECORD), validate(schemas.adminProofParams), payments.adminGetProof);
router.post('/payment-proofs/:proofId/approve', ...allow(P.PAYMENTS_RECORD), validate(schemas.adminApproveProof), payments.adminApproveProof);
router.post('/payment-proofs/:proofId/reject', ...allow(P.PAYMENTS_RECORD), validate(schemas.adminRejectProof), payments.adminRejectProof);

module.exports = router;
