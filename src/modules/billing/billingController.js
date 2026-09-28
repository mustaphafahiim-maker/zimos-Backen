'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../../core/errors/AppError');
const service = require('./billingService');
const { verifyGatewaySignature } = require('./gatewaySignature');

// POST /api/v1/billing/webhook  — no auth; identity comes from the signature.
// Verified against req.rawBody (the exact bytes the gateway signed), never the
// parsed body. A request that fails is unauthenticated, hence 401.
const webhook = asyncHandler(async (req, res) => {
  if (!verifyGatewaySignature(req.rawBody, req.headers)) {
    throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 401);
  }
  const result = await service.applyWebhookEvent(req.body);
  // Always 200 for a well-formed request so the gateway doesn't retry storms;
  // `handled: false` tells us it was a no-op.
  res.json({ received: true, ...result });
});

// POST /api/v1/billing/run-trial-check  — platform admin (manual for now).
const runTrialCheck = asyncHandler(async (req, res) => {
  res.json(await service.expireStaleTrials());
});

// GET /api/v1/admin/workspaces  — platform admin, JSON.
const adminWorkspaces = asyncHandler(async (req, res) => {
  res.json({ workspaces: await service.listWorkspacesOverview() });
});

// GET /api/v1/admin/dashboard  — platform admin, HTML table.
const adminDashboard = asyncHandler(async (req, res) => {
  res.removeHeader('Content-Security-Policy');
  res.render('admin-dashboard', {
    title: 'Platform admin',
    rows: await service.listWorkspacesOverview(),
  });
});

// GET /api/v1/workspaces/:workspaceId/billing  — the merchant's own summary.
const getWorkspaceBilling = asyncHandler(async (req, res) => {
  res.json({ billing: await service.getWorkspaceBilling(req.tenant.workspaceId) });
});

// POST /api/v1/workspaces/:workspaceId/billing/referral-code
// 201 when the code was attached; 200 when it already was.
const attachReferralCode = asyncHandler(async (req, res) => {
  const { billing, attached } = await service.attachReferralCode(req.tenant.workspaceId, req.body.code, req);
  res.status(attached ? 201 : 200).json({ billing, attached });
});

// PATCH /api/v1/workspaces/:workspaceId/billing  — monthly or annual, from the
// next charge. 409 OPEN_CHARGE_EXISTS while a charge is open.
const setBillingCycle = asyncHandler(async (req, res) => {
  const { changed } = await service.setBillingCycle(req.tenant.workspaceId, req.body.billingCycle, req);
  res.json({ billing: await service.getWorkspaceBilling(req.tenant.workspaceId), changed });
});

module.exports = {
  webhook,
  runTrialCheck,
  adminWorkspaces,
  adminDashboard,
  getWorkspaceBilling,
  attachReferralCode,
  setBillingCycle,
};
