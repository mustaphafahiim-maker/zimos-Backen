'use strict';

const multer = require('multer');
const asyncHandler = require('express-async-handler');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const paymentMethods = require('./paymentMethodService');
const proofs = require('./paymentProofService');
const { verifyProofImageLink } = require('./proofLinks');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: proofs.PROOF_MAX_BYTES, files: 1, fields: 6, fieldSize: 200 },
});

// A screenshot over the cap is refused while it streams in, never processed.
function acceptProofFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError('FILE_TOO_LARGE', `The screenshot is larger than ${proofs.PROOF_MAX_BYTES / (1024 * 1024)} MB`, 413));
      }
      return next(new AppError('UPLOAD_ERROR', err.message, 422));
    }
    return next(err);
  });
}

// ---------------------------------------------------------------- merchant

// GET /workspaces/:workspaceId/billing/payment-methods — never cached: a
// method turned off in the console must disappear at once.
const listPaymentMethods = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await paymentMethods.listForWorkspace(req.tenant.workspaceId));
});

// POST /workspaces/:workspaceId/billing/invoices/open — the charge to pay
// now and the ways to pay it; writes nothing, so always 200.
const openInvoice = asyncHandler(async (req, res) => {
  res.json(await proofs.openInvoice(req.tenant.workspaceId));
});

// POST /workspaces/:workspaceId/billing/invoices/:invoiceId/payment-proofs —
// multipart; `:invoiceId` may be `next` (the charge is written with the proof).
const submitInvoiceProof = asyncHandler(async (req, res) => {
  const proof = await proofs.submitForInvoice(
    req.tenant.workspaceId,
    req.params.invoiceId,
    {
      methodCode: req.body.methodCode,
      senderPhone: req.body.senderPhone,
      expectedAmount: req.body.expectedAmount,
      file: req.file,
    },
    req
  );
  res.status(201).json({ proof });
});

const listPaymentProofs = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await proofs.listForWorkspace(req.tenant.workspaceId));
});

// ----------------------------------------------------------------- console

const adminListPaymentMethods = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await paymentMethods.listForAdmin());
});

const adminUpdatePaymentMethod = asyncHandler(async (req, res) => {
  res.json({ method: await paymentMethods.updateMethod(req.params.code, req.body, req) });
});

const adminReorderPaymentMethods = asyncHandler(async (req, res) => {
  res.json(await paymentMethods.reorder(req.body.codes, req));
});

const adminUpdatePaymentMethodAccount = asyncHandler(async (req, res) => {
  res.json({ method: await paymentMethods.updateManualDetails(req.params.code, req.body, req) });
});

const adminListProofs = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await proofs.listQueue(req.query));
});

const adminGetProof = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await proofs.getForReview(req.params.proofId));
});

const adminApproveProof = asyncHandler(async (req, res) => {
  res.json(await proofs.approve(req.params.proofId, req.body, req));
});

const adminRejectProof = asyncHandler(async (req, res) => {
  res.json(await proofs.reject(req.params.proofId, req.body, req));
});

// ------------------------------------------------------------ signed image

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /payment-proofs/:proofId/image?expires=&signature= — the signature is the credential.
const readProofImage = asyncHandler(async (req, res) => {
  const { proofId } = req.params;
  if (!UUID.test(proofId) || !verifyProofImageLink(proofId, req.query.expires, req.query.signature)) {
    // The same answer for a forged, an expired and an unknown link.
    throw new NotFoundError('Image');
  }
  const file = await proofs.readImage(proofId);
  if (!file) throw new NotFoundError('Image');
  const remaining = Math.max(0, Number(req.query.expires) - Math.floor(Date.now() / 1000));
  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.buffer.length),
    'Cache-Control': `private, max-age=${remaining}`,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(file.buffer);
});

module.exports = {
  acceptProofFile,
  listPaymentMethods,
  openInvoice,
  submitInvoiceProof,
  listPaymentProofs,
  adminListPaymentMethods,
  adminUpdatePaymentMethod,
  adminReorderPaymentMethods,
  adminUpdatePaymentMethodAccount,
  adminListProofs,
  adminGetProof,
  adminApproveProof,
  adminRejectProof,
  readProofImage,
};
