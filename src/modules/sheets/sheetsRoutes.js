'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const queue = require('../../core/queue');
const secretBox = require('../../core/utils/secretBox');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getSheetsAdapter, describeAdapter } = require('./adapters');
const sync = require('./sheetSync');

/**
 * Google Sheets (SPEC §16.4), the store's side: connect a Google account,
 * then any number of sheets, each with what it carries (orders, lost orders
 * or leads), which ones (products, funnels), its columns and one row per order
 * or per product. sheetSync.js does the writing.
 *
 * Mounted at /api/v1/workspaces/:workspaceId/integrations/google-sheets (apps.manage;
 * changes need the Google Sheets app installed, appGate.js).
 *
 *   GET    /                         the adapter, the account, the connections
 *   POST   /authorize                { redirectUri } → { url } to send the merchant to
 *   POST   /account                  { code, state } — the redirect's answer
 *   DELETE /account                  forget the account (every sheet stops)
 *   POST   /connections              a new sheet (created, or an id the app may use)
 *   PATCH  /connections/:id          name, filter, columns, rows, pause/resume
 *   DELETE /connections/:id
 *   POST   /connections/:id/backfill "Sync existing" — the last 30 days
 *   GET    /connections/:id/rows     what was written (adapters that can read: the sandbox)
 */

const PROVIDER = 'google_sheets';
const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_CONNECTIONS = 20;
const PREVIEW_ROWS = 200;

// OAuth state: the store and teammate, signed, so the code cannot be taken to another store.
const sign = (body) => crypto.createHmac('sha256', env.jwt.accessSecret).update(`sheets:${body}`).digest('base64url');
function makeState(workspaceId, userId) {
  const body = `${workspaceId}.${userId}.${Date.now() + STATE_TTL_MS}`;
  return `${body}.${sign(body)}`;
}
function checkState(state, workspaceId, userId) {
  const parts = String(state || '').split('.');
  const mac = parts.pop();
  const body = parts.join('.');
  const [ws, user, expires] = parts;
  const expected = sign(body);
  const ok =
    Boolean(mac) &&
    mac.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac)) &&
    ws === workspaceId &&
    user === userId &&
    Number(expires) > Date.now();
  if (!ok) throw new AppError('SHEETS_STATE_INVALID', 'The Google sign-in expired or was for another store — try again', 400);
}

function present(connection) {
  return {
    id: connection.id,
    name: connection.name,
    dataType: connection.dataType,
    spreadsheetId: connection.spreadsheetId,
    spreadsheetUrl: connection.spreadsheetUrl,
    sheetName: connection.sheetName,
    filter: connection.filter || {},
    columns: connection.columns || [],
    groupByOrder: connection.groupByOrder,
    status: connection.status,
    lastError: connection.lastError,
    lastSyncedAt: connection.lastSyncedAt,
    rowsWritten: connection.rowsWritten,
    createdAt: connection.createdAt,
  };
}

async function overview(workspaceId) {
  const integration = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER } });
  const connections = await db.SheetConnection.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  return {
    adapter: describeAdapter(),
    account: integration && integration.status === 'connected' ? { connected: true, email: (integration.config || {}).account || null } : { connected: false, email: null },
    connections: connections.map(present),
    lostColumns: sync.LOST_COLUMNS.map(({ key, en, ar }) => ({ key, label: { en, ar } })),
    leadColumns: sync.LEAD_COLUMNS.map(({ key, en, ar }) => ({ key, label: { en, ar } })),
    backfillDays: sync.BACKFILL_DAYS,
  };
}

async function connectAccount(workspaceId, { code, state }, req) {
  checkState(state, workspaceId, req.user.id);
  const adapter = getSheetsAdapter();
  const { account, credentials } = await adapter.exchangeCode(code);
  const values = { status: 'connected', config: { account, adapter: adapter.name }, secretsSealed: secretBox.seal(JSON.stringify(credentials)), lastVerifiedAt: new Date(), lastError: null };
  const existing = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER } });
  if (existing) await existing.update(values);
  else await db.WorkspaceIntegration.create({ workspaceId, provider: PROVIDER, ...values });
  // Sheets that stopped because the access was taken away can go on with the new one.
  await db.SheetConnection.update({ status: 'active', lastError: null }, { where: { workspaceId, status: 'revoked' } });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'sheets.account_connect', entityType: 'WorkspaceIntegration', metadata: { account }, req });
  return overview(workspaceId);
}

async function disconnectAccount(workspaceId, req) {
  await db.WorkspaceIntegration.destroy({ where: { workspaceId, provider: PROVIDER } });
  await db.SheetConnection.update({ status: 'revoked', lastError: 'The Google account was disconnected' }, { where: { workspaceId, status: ['active', 'paused'] } });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'sheets.account_disconnect', entityType: 'WorkspaceIntegration', req });
  return overview(workspaceId);
}

function checkColumns(dataType, columns) {
  const known = new Set(dataType === 'orders' ? require('../orders/orderExportService').COLUMN_KEYS : dataType === 'leads' ? sync.LEAD_KEYS : sync.LOST_KEYS);
  const bad = columns.filter((c) => c.key && !known.has(c.key) && !(dataType === 'orders' && /^field:custom_[1-5]$/.test(c.key)));
  if (bad.length) throw new AppError('VALIDATION_ERROR', `Unknown column: ${bad.map((c) => c.key).join(', ')}`, 422);
}

async function createConnection(workspaceId, body, req) {
  const credentials = await sync.credentialsFor(workspaceId);
  if (!credentials) throw new AppError('SHEETS_NOT_CONNECTED', 'Connect a Google account first', 409);
  if ((await db.SheetConnection.count({ where: { workspaceId } })) >= MAX_CONNECTIONS) {
    throw new AppError('VALIDATION_ERROR', `A store keeps at most ${MAX_CONNECTIONS} sheets`, 422);
  }
  checkColumns(body.dataType, body.columns);
  const adapter = getSheetsAdapter();
  const sheet = body.spreadsheetId
    ? await adapter.openSpreadsheet(credentials, { spreadsheetId: body.spreadsheetId, sheetName: body.sheetName })
    : await adapter.createSpreadsheet(credentials, { title: body.name });
  const connection = await db.SheetConnection.create({
    workspaceId,
    name: body.name,
    dataType: body.dataType,
    spreadsheetId: sheet.spreadsheetId,
    spreadsheetUrl: sheet.url,
    sheetName: sheet.sheetName,
    // Phones as the teammate who connects it may see them (SPEC §3.4 #8).
    filter: { ...body.filter, lang: body.lang, maskPhones: !req.tenant.hasPermission('customers.reveal_sensitive') },
    columns: body.columns,
    groupByOrder: body.groupByOrder,
    createdBy: req.user.id,
  });
  await adapter.setHeader(credentials, { spreadsheetId: connection.spreadsheetId, sheetName: connection.sheetName, header: sync.headerOf(connection) });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'sheets.connection_create', entityType: 'SheetConnection', entityId: connection.id, after: present(connection), req });
  return present(connection);
}

async function loadConnection(workspaceId, id) {
  const connection = await db.SheetConnection.findOne({ where: { id, workspaceId } });
  if (!connection) throw new NotFoundError('Sheet connection');
  return connection;
}

async function updateConnection(workspaceId, id, body, req) {
  const connection = await loadConnection(workspaceId, id);
  const before = present(connection);
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.groupByOrder !== undefined) patch.groupByOrder = body.groupByOrder;
  if (body.filter !== undefined || body.lang !== undefined) {
    patch.filter = { ...connection.filter, ...(body.filter || {}), ...(body.lang ? { lang: body.lang } : {}) };
  }
  if (body.columns !== undefined) {
    checkColumns(connection.dataType, body.columns);
    patch.columns = body.columns;
  }
  if (body.status !== undefined) {
    if (connection.status === 'revoked' && body.status === 'active') throw new AppError('SHEETS_NOT_CONNECTED', 'Connect the Google account again first', 409);
    patch.status = body.status;
    if (body.status === 'active') patch.lastError = null;
  }
  await connection.update(patch);
  // New titles go on row 1; rows already written keep the layout they were written in.
  if (patch.columns) {
    const credentials = await sync.credentialsFor(workspaceId);
    if (credentials) await getSheetsAdapter().setHeader(credentials, { spreadsheetId: connection.spreadsheetId, sheetName: connection.sheetName, header: sync.headerOf(connection) });
  }
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'sheets.connection_update', entityType: 'SheetConnection', entityId: id, before, after: present(connection), req });
  return present(connection);
}

async function deleteConnection(workspaceId, id, req) {
  const connection = await loadConnection(workspaceId, id);
  await connection.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'sheets.connection_delete', entityType: 'SheetConnection', entityId: id, req });
  return { deleted: true, id };
}

async function startBackfill(workspaceId, id, req) {
  const connection = await loadConnection(workspaceId, id);
  if (connection.status !== 'active') throw new AppError('SHEETS_NOT_ACTIVE', 'Resume the sheet first', 409);
  await queue.add('io', 'sheets.backfill', { connectionId: id }, { workspaceId, dedupeKey: `sheets-backfill:${id}:${Math.floor(Date.now() / 60000)}` });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'sheets.backfill', entityType: 'SheetConnection', entityId: id, req });
  return { queued: true, days: sync.BACKFILL_DAYS };
}

async function readRows(workspaceId, id) {
  const connection = await loadConnection(workspaceId, id);
  const adapter = getSheetsAdapter();
  if (!adapter.readRows) throw new AppError('SHEETS_PREVIEW_UNAVAILABLE', 'Open the sheet in Google Sheets to see it', 409);
  const credentials = await sync.credentialsFor(workspaceId);
  if (!credentials) throw new AppError('SHEETS_NOT_CONNECTED', 'Connect a Google account first', 409);
  // The header and the newest rows: what the merchant checks after a change.
  const rows = await adapter.readRows(credentials, { spreadsheetId: connection.spreadsheetId, sheetName: connection.sheetName });
  return { rows: rows.length > PREVIEW_ROWS ? [rows[0], ...rows.slice(1 - PREVIEW_ROWS)] : rows, total: Math.max(0, rows.length - 1) };
}

// ------------------------------------------------------------------ routes --

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const one = Joi.object({ ...ws, connectionId: uuid.required() });
const column = Joi.object({
  header: Joi.string().trim().min(1).max(80).required(),
  key: Joi.string().max(40),
  fixed: Joi.string().allow('').max(200),
}).xor('key', 'fixed');
const filter = Joi.object({
  productIds: Joi.array().items(uuid).max(200),
  funnelIds: Joi.array().items(uuid).max(200),
});
const lang = Joi.string().valid('ar', 'en');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.APPS_MANAGE));
router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await overview(req.tenant.workspaceId))));
router.post(
  '/authorize',
  validate({ params: Joi.object(ws), body: Joi.object({ redirectUri: Joi.string().uri({ scheme: ['http', 'https'] }).max(500).required() }) }),
  asyncHandler(async (req, res) =>
    res.json({ url: getSheetsAdapter().authorizeUrl({ redirectUri: req.body.redirectUri, state: makeState(req.tenant.workspaceId, req.user.id) }) })
  )
);
router.post(
  '/account',
  validate({ params: Joi.object(ws), body: Joi.object({ code: Joi.string().max(2000).required(), state: Joi.string().max(400).required() }) }),
  asyncHandler(async (req, res) => res.json(await connectAccount(req.tenant.workspaceId, req.body, req)))
);
router.delete('/account', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await disconnectAccount(req.tenant.workspaceId, req))));
router.post(
  '/connections',
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      name: Joi.string().trim().min(1).max(80).required(),
      dataType: Joi.string().valid('orders', 'lost_orders', 'leads').required(),
      spreadsheetId: Joi.string().trim().max(200).pattern(/^[A-Za-z0-9_-]+$/).optional(),
      sheetName: Joi.string().trim().max(100).optional(),
      filter: filter.default({}),
      columns: Joi.array().items(column).min(1).max(60).required(),
      groupByOrder: Joi.boolean().default(true),
      lang: lang.default('ar'),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ connection: await createConnection(req.tenant.workspaceId, req.body, req) }))
);
router.patch(
  '/connections/:connectionId',
  validate({
    params: one,
    body: Joi.object({
      name: Joi.string().trim().min(1).max(80),
      filter,
      columns: Joi.array().items(column).min(1).max(60),
      groupByOrder: Joi.boolean(),
      lang,
      status: Joi.string().valid('active', 'paused'),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ connection: await updateConnection(req.tenant.workspaceId, req.params.connectionId, req.body, req) }))
);
router.delete('/connections/:connectionId', validate({ params: one }), asyncHandler(async (req, res) => res.json(await deleteConnection(req.tenant.workspaceId, req.params.connectionId, req))));
router.post('/connections/:connectionId/backfill', validate({ params: one }), asyncHandler(async (req, res) => res.json(await startBackfill(req.tenant.workspaceId, req.params.connectionId, req))));
router.get('/connections/:connectionId/rows', validate({ params: one }), asyncHandler(async (req, res) => res.json(await readRows(req.tenant.workspaceId, req.params.connectionId))));

module.exports = { router };
