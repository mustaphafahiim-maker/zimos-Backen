'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');
const { recordAudit } = require('../audit/auditService');
const { getAdsAdapter, ADS_ADAPTER_CODES } = require('./adapters');

/*
 * Ad accounts (spec-gaps item 261, SPEC §15.4): the merchant connects an ads
 * adapter with its credentials, picks the ad accounts to follow (the hourly
 * spend sync then pulls those), and can pause / resume a campaign and change
 * its daily budget from ZIMOS (P2). One workspace_integrations row per
 * adapter (`ads:<code>`, unique per store): config { accounts, selectedAccountIds,
 * campaigns }, the credentials sealed. Only the sandbox adapter exists; a real
 * platform is an adapter (adapters/README.md). No migration.
 */

const key = (code) => `ads:${code}`;
const adapterOr404 = (code) => {
  const adapter = getAdsAdapter(code);
  if (!adapter) throw new NotFoundError('Ads adapter');
  return adapter;
};
const secretsOf = (row) => {
  if (!row.secretsSealed) return null;
  try {
    return JSON.parse(secretBox.open(row.secretsSealed));
  } catch {
    return null;
  }
};

function serialize(row) {
  const config = row.config || {};
  const selected = new Set(config.selectedAccountIds || []);
  return {
    adapter: row.provider.slice(4),
    status: row.status,
    accounts: (config.accounts || []).map((a) => ({ ...a, selected: selected.has(a.accountId) })),
    campaigns: config.campaigns || {},
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    // The credentials are sealed and never returned.
  };
}

async function connectionOf(workspaceId, code) {
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: key(code) } });
  if (!row) throw new NotFoundError('Ad connection');
  return row;
}

async function connect(workspaceId, { adapter: code, credentials }, req) {
  const adapter = adapterOr404(code);
  const check = await adapter.validateCredentials({ config: {}, secrets: credentials });
  if (!check.ok) throw new AppError('ADS_CREDENTIALS_REJECTED', check.error || 'The ad platform did not accept these credentials', 422);
  const accounts = (await adapter.listAdAccounts({ config: {}, secrets: credentials })).slice(0, 200).map((a) => ({
    accountId: String(a.accountId), name: String(a.name || a.accountId).slice(0, 200), platform: a.platform, currency: a.currency || null,
  }));
  const existing = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: key(code) } });
  const previous = (existing && existing.config) || {};
  // A reconnect keeps the picks that still exist.
  const keep = (previous.selectedAccountIds || []).filter((id) => accounts.some((a) => a.accountId === id));
  const values = {
    status: 'connected',
    config: { accounts, selectedAccountIds: keep, campaigns: previous.campaigns || {}, accountName: check.accountName || null },
    secretsSealed: secretBox.seal(JSON.stringify(credentials || {})),
    lastVerifiedAt: new Date(),
    lastError: null,
  };
  const row = existing ? await existing.update(values) : await db.WorkspaceIntegration.create({ workspaceId, provider: key(code), ...values });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'ads.connect', entityType: 'WorkspaceIntegration', entityId: row.id, after: { adapter: code, accounts: accounts.length }, req });
  return serialize(row);
}

async function selectAccounts(workspaceId, code, accountIds, req) {
  const row = await connectionOf(workspaceId, code);
  const known = new Set(((row.config || {}).accounts || []).map((a) => a.accountId));
  const unknown = accountIds.filter((id) => !known.has(id));
  if (unknown.length) throw new ValidationError([{ field: 'accountIds', message: `Not an account of this connection: ${unknown.join(', ')}` }]);
  await row.update({ config: { ...(row.config || {}), selectedAccountIds: [...new Set(accountIds)] } });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'ads.accounts_select', entityType: 'WorkspaceIntegration', entityId: row.id, after: { adapter: code, accountIds }, req });
  return serialize(row);
}

async function disconnect(workspaceId, code, req) {
  const row = await connectionOf(workspaceId, code);
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'ads.disconnect', entityType: 'WorkspaceIntegration', entityId: row.id, after: { adapter: code }, req });
  // Spend already recorded stays: it is the store's history.
  return { disconnected: true };
}

/** Pause / resume (status) or a new daily budget (dailyBudgetAmount) for one campaign of a picked account. */
async function controlCampaign(workspaceId, campaignId, { adapter: code, accountId, status, dailyBudgetAmount }, req) {
  const adapter = adapterOr404(code);
  const row = await connectionOf(workspaceId, code);
  const config = row.config || {};
  if (!(config.selectedAccountIds || []).includes(accountId)) throw new ValidationError([{ field: 'accountId', message: 'Pick this ad account on the connection first' }]);
  const args = { config, secrets: secretsOf(row), accountId, campaignId };
  let result;
  try {
    result = status !== undefined ? await adapter.setCampaignStatus({ ...args, status }) : await adapter.setCampaignBudget({ ...args, dailyBudgetAmount });
  } catch (err) {
    throw new AppError('ADS_PLATFORM_UNREACHABLE', `Could not reach the ad platform: ${err.message}`, 502);
  }
  if (!result || !result.ok) throw new AppError('ADS_CHANGE_REFUSED', (result && result.error) || 'The ad platform refused the change', 422);
  const k = `${accountId}:${campaignId}`;
  const state = { ...((config.campaigns || {})[k] || {}), ...(status !== undefined ? { status: result.status || status } : { dailyBudgetAmount: String(result.dailyBudgetAmount ?? dailyBudgetAmount) }), updatedAt: new Date().toISOString() };
  await row.update({ config: { ...config, campaigns: { ...(config.campaigns || {}), [k]: state } } });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: status !== undefined ? 'ads.campaign_status' : 'ads.campaign_budget', entityType: 'WorkspaceIntegration', entityId: row.id, after: { adapter: code, accountId, campaignId, ...state }, req });
  return { campaignId, accountId, ...state };
}

// Mounted inside profitRoutes at /api/v1/workspaces/:workspaceId/profit/ads (after authenticate/resolveTenant).
const router = Router({ mergeParams: true });
const READ = requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW);
const WRITE = requirePermission(PERMISSIONS.PROFIT_MANAGE);
const ws = { workspaceId: Joi.string().uuid().required() };
const adapterCode = Joi.string().valid(...ADS_ADAPTER_CODES);

router.get('/adapters', READ, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  res.json({ adapters: ADS_ADAPTER_CODES.map((c) => getAdsAdapter(c).describe()) });
}));
router.get('/connections', READ, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const rows = await db.WorkspaceIntegration.findAll({ where: { workspaceId: req.tenant.workspaceId, provider: ADS_ADAPTER_CODES.map(key) }, order: [['createdAt', 'ASC']] });
  res.json({ connections: rows.map(serialize) });
}));
router.post('/connections', WRITE, validate({ params: Joi.object(ws), body: Joi.object({ adapter: adapterCode.required(), credentials: Joi.object().max(20).default({}) }) }), asyncHandler(async (req, res) => {
  res.status(201).json({ connection: await connect(req.tenant.workspaceId, req.body, req) });
}));
router.put('/connections/:adapter/accounts', WRITE, validate({ params: Joi.object({ ...ws, adapter: adapterCode.required() }), body: Joi.object({ accountIds: Joi.array().items(Joi.string().max(100)).max(200).required() }) }), asyncHandler(async (req, res) => {
  res.json({ connection: await selectAccounts(req.tenant.workspaceId, req.params.adapter, req.body.accountIds, req) });
}));
router.delete('/connections/:adapter', WRITE, validate({ params: Joi.object({ ...ws, adapter: adapterCode.required() }) }), asyncHandler(async (req, res) => {
  res.json(await disconnect(req.tenant.workspaceId, req.params.adapter, req));
}));
const control = { adapter: adapterCode.required(), accountId: Joi.string().max(100).required() };
router.post('/campaigns/:campaignId/status', WRITE, validate({ params: Joi.object({ ...ws, campaignId: Joi.string().max(100).required() }), body: Joi.object({ ...control, status: Joi.string().valid('paused', 'active').required() }) }), asyncHandler(async (req, res) => {
  res.json({ campaign: await controlCampaign(req.tenant.workspaceId, req.params.campaignId, req.body, req) });
}));
router.put('/campaigns/:campaignId/budget', WRITE, validate({ params: Joi.object({ ...ws, campaignId: Joi.string().max(100).required() }), body: Joi.object({ ...control, dailyBudgetAmount: Joi.number().integer().min(1).max(1e12).required() }) }), asyncHandler(async (req, res) => {
  res.json({ campaign: await controlCampaign(req.tenant.workspaceId, req.params.campaignId, req.body, req) });
}));

module.exports = { router, connect, selectAccounts, disconnect, controlCampaign };
