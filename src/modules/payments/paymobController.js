'use strict';
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const service = require('./paymobService');

/** Public base URL of this API, for the webhook URL shown to the merchant. */
function apiBase(req) {
  const explicit = process.env.PUBLIC_API_URL;
  if (explicit) return `${explicit.replace(/\/+$/, '')}/api/${env.apiVersion}`;
  return `${req.protocol}://${req.get('host')}/api/${env.apiVersion}`;
}

const getIntegration = asyncHandler(async (req, res) => {
  res.json({ integration: service.integrationView(await service.getIntegration(req.tenant.workspaceId), apiBase(req)) });
});
const connect = asyncHandler(async (req, res) => {
  const integration = await service.connect(req.tenant.workspaceId, req.body, req);
  res.json({ integration: service.integrationView(integration, apiBase(req)) });
});
const disconnect = asyncHandler(async (req, res) => {
  res.json(await service.disconnect(req.tenant.workspaceId, req));
});

const paymentOptions = asyncHandler(async (req, res) => {
  res.json(await service.paymentOptions(req.tenant.workspaceId));
});
const pay = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createCheckout(req.tenant.workspaceId, req.params.orderId));
});

const webhook = asyncHandler(async (req, res) => {
  const result = await service.handleWebhook(req.params.workspaceId, req.query.hmac, req.body);
  res.json({ received: true, ...result });
});

module.exports = { getIntegration, connect, disconnect, paymentOptions, pay, webhook };
