'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const validate = require('../../../core/middleware/validate');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const { zonedMidnight } = require('../../../core/utils/zonedMonth');
const { ValidationError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const ledger = require('./ledgerService');
const payouts = require('./payoutSync');

/**
 * The online payments ledger and payouts (item 384). Used inside
 * onlinePaymentRoutes (already behind authenticate + resolveTenant), so the
 * paths are /workspaces/:workspaceId/payments/transactions and /payouts.
 * Reading needs financial_reports.view, like the COD settlements.
 */
const router = Router({ mergeParams: true });
const READ = requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW);

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
// A day of the store's calendar (YYYY-MM-DD) or a full ISO timestamp.
const when = Joi.alternatives().try(Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/), Joi.date().iso());
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `from` at the start of its day and `to` at the end of its day, on the store's clock. */
async function windowOf(workspaceId, query) {
  const w = await db.Workspace.findByPk(workspaceId, { attributes: ['timezone'] });
  let tz = (w && w.timezone) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const at = (v, endOfDay) => {
    if (typeof v === 'string' && DAY_ONLY.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      return zonedMidnight(y, m - 1, d + (endOfDay ? 1 : 0), tz);
    }
    return new Date(v);
  };
  const from = query.from ? at(query.from, false) : undefined;
  const to = query.to ? at(query.to, true) : undefined;
  if (from && to && !(from < to)) throw new ValidationError([{ field: 'from', message: '`from` must be before `to`' }]);
  return { from, to, tz };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  // A cell a spreadsheet would run as a formula is kept as text.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get(
  '/transactions',
  READ,
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      gateway: Joi.string().max(50),
      method: Joi.string().max(20),
      status: Joi.string().valid(...ledger.STATUSES),
      type: Joi.string().valid(...ledger.TYPES),
      mode: Joi.string().valid('live', 'test'),
      orderId: uuid,
      payoutId: uuid,
      from: when,
      to: when,
      limit: Joi.number().integer().min(1).max(200).default(50),
      cursor: Joi.string().max(100),
      format: Joi.string().valid('json', 'csv', 'xlsx').default('json'),
      lang: Joi.string().valid('en', 'ar').default('en'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.tenant;
    const { format, lang, ...rest } = req.query;
    const { from, to, tz } = await windowOf(workspaceId, rest);
    const filters = { ...rest, from, to };
    if (format === 'json') return res.json(await ledger.listTransactions(workspaceId, filters));

    const table = await ledger.exportTable(workspaceId, filters, { lang, timezone: tz });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'payment_transactions.export',
      entityType: 'Payment',
      metadata: { format, rows: table.length - 1, filters: { ...rest, cursor: undefined, limit: undefined } },
      req,
    });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'xlsx') {
      const file = require('../../orders/xlsxWriter').buildXlsx(table, { sheetName: lang === 'ar' ? 'المدفوعات' : 'Payments', rtl: lang === 'ar' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="payments-${day}.xlsx"`);
      return res.send(file);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${day}.csv"`);
    return res.send(`﻿${table.map((row) => row.map(csvCell).join(',')).join('\n')}`);
  })
);

router.get(
  '/payouts',
  READ,
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      gateway: Joi.string().max(50),
      status: Joi.string().valid(...payouts.STATUSES),
      from: Joi.string().pattern(DAY_ONLY),
      to: Joi.string().pattern(DAY_ONLY),
      limit: Joi.number().integer().min(1).max(100).default(50),
      cursor: Joi.string().max(100),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await ledger.listPayouts(req.tenant.workspaceId, req.query)))
);

// "Refresh": asks the store's gateways for their payouts now (otherwise once a day).
router.post(
  '/payouts/sync',
  READ,
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ results: await payouts.syncWorkspace(req.tenant.workspaceId, req) }))
);

router.get(
  '/payouts/:payoutId',
  READ,
  validate({ params: Joi.object({ ...ws, payoutId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await ledger.getPayout(req.tenant.workspaceId, req.params.payoutId)))
);

module.exports = router;
