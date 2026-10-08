'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const { NotFoundError, ValidationError } = require('../../../core/errors/AppError');
const gateways = require('../gateways');

/**
 * The online payments ledger (item 384): every online payment that was
 * captured or failed, and every refund of one, with the gateway's fee, the net
 * that reached (or left) the balance and the payout that carried it.
 *
 *   type     payment | refund
 *   status   payment: captured (its own state in paymentStatus: captured,
 *            partially_refunded, refunded) or failed; refund: refunded
 *            (processed), pending or failed
 *   amount   signed: a refund is negative
 *   fee      what the gateway kept, in feeCurrency; null = not known yet
 *   net      what reached the balance (a refund: what left it); null = not
 *            known yet, or nothing moved (a failure, a pending refund). A
 *            processed refund with no fee known counts its whole amount.
 *
 * Only gateways (gateways/index.js) — not cash on delivery, transfers, gift
 * cards or points. Newest first; the cursor is the last row's
 * `<occurredAt>|<id>`.
 */

const STATUSES = ['captured', 'refunded', 'failed', 'pending'];
const TYPES = ['payment', 'refund'];
const MAX_EXPORT = 10000;
const MAX_PAYOUT_LINES = 5000;

const num = (v) => (v === null || v === undefined ? null : Number(v));
const gatewayCodes = () => gateways.listAdapters().map((a) => a.code);

const ROWS = `
  SELECT 'payment' AS type, p.id, p.order_id, p.provider_code AS gateway, p.method, p.mode,
         CASE WHEN p.status = 'failed' THEN 'failed' ELSE 'captured' END AS status,
         p.status::text AS payment_status, p.id AS payment_id,
         p.amount AS amount, p.currency, p.fee_amount AS fee, p.fee_currency,
         CASE WHEN p.status = 'failed' THEN NULL ELSE p.net_amount END AS net,
         p.payout_id, p.provider_transaction_id AS reference, p.masked_display,
         CASE WHEN p.status = 'failed' THEN p.updated_at ELSE COALESCE(p.paid_at, p.updated_at) END AS occurred_at,
         p.failure_reason, NULL::text AS source
    FROM payments p
   WHERE p.workspace_id = :ws AND p.provider_code IN (:codes)
     AND p.status IN ('captured', 'partially_refunded', 'refunded', 'failed')
  UNION ALL
  SELECT 'refund', r.id, r.order_id, p.provider_code, p.method, p.mode,
         CASE r.status WHEN 'processed' THEN 'refunded' ELSE r.status::text END,
         p.status::text, p.id,
         -r.amount, p.currency, r.fee_amount, COALESCE(r.fee_currency, p.fee_currency),
         CASE WHEN r.status <> 'processed' THEN NULL ELSE COALESCE(r.net_amount, -r.amount - COALESCE(r.fee_amount, 0)) END,
         r.payout_id, r.provider_refund_reference, NULL,
         COALESCE(r.processed_at, r.created_at),
         r.failure_reason, r.source
    FROM refunds r JOIN payments p ON p.id = r.payment_id
   WHERE r.workspace_id = :ws AND p.provider_code IN (:codes)`;

function parseCursor(cursor) {
  if (!cursor) return null;
  const [at, id] = String(cursor).split('|');
  const when = new Date(at);
  if (Number.isNaN(when.getTime()) || !/^[0-9a-f-]{36}$/i.test(id || '')) {
    throw new ValidationError([{ field: 'cursor', message: 'Not a cursor from this list' }]);
  }
  return { at: when, id };
}

function filtersSql(q) {
  const where = [];
  const r = {};
  if (q.gateway) { where.push('t.gateway = :gateway'); r.gateway = q.gateway; }
  if (q.method) { where.push('t.method = :method'); r.method = q.method; }
  if (q.status) { where.push('t.status = :status'); r.status = q.status; }
  if (q.type) { where.push('t.type = :type'); r.type = q.type; }
  if (q.mode) { where.push('t.mode = :mode'); r.mode = q.mode; }
  if (q.orderId) { where.push('t.order_id = :orderId'); r.orderId = q.orderId; }
  if (q.payoutId) { where.push('t.payout_id = :payoutId'); r.payoutId = q.payoutId; }
  if (q.from) { where.push('t.occurred_at >= :from'); r.from = q.from; }
  if (q.to) { where.push('t.occurred_at < :to'); r.to = q.to; }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', replacements: r };
}

function serialize(row) {
  return {
    type: row.type,
    id: row.id,
    paymentId: row.payment_id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    gateway: row.gateway,
    method: row.method,
    mode: row.mode,
    status: row.status,
    paymentStatus: row.payment_status,
    amount: num(row.amount),
    currency: row.currency,
    fee: num(row.fee),
    feeCurrency: row.fee_currency,
    net: num(row.net),
    payoutId: row.payout_id,
    payout: row.payout_id ? { id: row.payout_id, externalId: row.payout_external_id, status: row.payout_status, arrivalDate: row.payout_arrival_date } : null,
    reference: row.reference,
    maskedDisplay: row.masked_display,
    failureReason: row.failure_reason,
    source: row.source,
    occurredAt: row.occurred_at,
  };
}

async function query(workspaceId, q, { limit, cursor } = {}) {
  const codes = gatewayCodes();
  const f = filtersSql(q);
  const after = parseCursor(cursor);
  const cursorSql = after ? `${f.sql ? ' AND' : 'WHERE'} (t.occurred_at, t.id) < (:cAt, :cId)` : '';
  return db.sequelize.query(
    `SELECT t.*, o.order_number, gp.external_id AS payout_external_id, gp.status AS payout_status, gp.arrival_date AS payout_arrival_date
       FROM (${ROWS}) t
       JOIN orders o ON o.id = t.order_id
       LEFT JOIN gateway_payouts gp ON gp.id = t.payout_id
       ${f.sql}${cursorSql}
      ORDER BY t.occurred_at DESC, t.id DESC
      LIMIT :limit`,
    {
      replacements: { ws: workspaceId, codes, ...f.replacements, ...(after ? { cAt: after.at, cId: after.id } : {}), limit },
      type: QueryTypes.SELECT,
    }
  );
}

/** Totals per currency over everything the filters select (not only the page). */
async function totals(workspaceId, q) {
  const f = filtersSql(q);
  const rows = await db.sequelize.query(
    `SELECT t.currency,
            count(*) FILTER (WHERE t.type = 'payment' AND t.status = 'captured')::int AS payments,
            COALESCE(sum(t.amount) FILTER (WHERE t.type = 'payment' AND t.status = 'captured'), 0) AS captured,
            count(*) FILTER (WHERE t.type = 'refund' AND t.status = 'refunded')::int AS refunds,
            COALESCE(sum(-t.amount) FILTER (WHERE t.type = 'refund' AND t.status = 'refunded'), 0) AS refunded,
            count(*) FILTER (WHERE t.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE t.type = 'payment' AND t.status = 'captured' AND t.fee IS NULL)::int AS "feesPending"
       FROM (${ROWS}) t ${f.sql}
      GROUP BY 1 ORDER BY 1`,
    { replacements: { ws: workspaceId, codes: gatewayCodes(), ...f.replacements }, type: QueryTypes.SELECT }
  );
  // Fees and net are in the gateway's settlement currency, which may differ from the payment's.
  const fees = await db.sequelize.query(
    `SELECT t.fee_currency AS currency, COALESCE(sum(t.fee), 0) AS fees, COALESCE(sum(t.net), 0) AS net
       FROM (${ROWS}) t ${f.sql}${f.sql ? ' AND' : ' WHERE'} t.fee_currency IS NOT NULL AND t.net IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    { replacements: { ws: workspaceId, codes: gatewayCodes(), ...f.replacements }, type: QueryTypes.SELECT }
  );
  return {
    byCurrency: rows.map((r) => ({ ...r, captured: Number(r.captured), refunded: Number(r.refunded) })),
    feesByCurrency: fees.map((r) => ({ currency: r.currency, fees: Number(r.fees), net: Number(r.net) })),
  };
}

async function listTransactions(workspaceId, q) {
  const limit = q.limit || 50;
  const rows = await query(workspaceId, q, { limit, cursor: q.cursor });
  const list = rows.map(serialize);
  const last = rows[rows.length - 1];
  return {
    transactions: list,
    totals: q.cursor ? undefined : await totals(workspaceId, q),
    nextCursor: rows.length === limit && last ? `${new Date(last.occurred_at).toISOString()}|${last.id}` : null,
  };
}

const COLUMNS = {
  en: ['Date', 'Type', 'Status', 'Order', 'Gateway', 'Method', 'Mode', 'Amount', 'Currency', 'Fee', 'Fee currency', 'Net', 'Payout', 'Payout status', 'Payout arrival', 'Gateway reference', 'Card', 'Failure reason'],
  ar: ['التاريخ', 'النوع', 'الحالة', 'الطلب', 'البوابة', 'الطريقة', 'الوضع', 'المبلغ', 'العملة', 'الرسوم', 'عملة الرسوم', 'الصافي', 'التحويل', 'حالة التحويل', 'وصول التحويل', 'مرجع البوابة', 'البطاقة', 'سبب الفشل'],
};
const WORDS = {
  ar: { payment: 'دفعة', refund: 'استرداد', captured: 'مدفوع', refunded: 'مسترد', failed: 'فشل', pending: 'قيد التنفيذ', live: 'حقيقي', test: 'تجريبي' },
};

/** Amounts in the file are decimal (2 digits, 3 for KWD/BHD/OMR/JOD/TND), as the store's other exports. */
const DIGITS = { KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3, JPY: 0, KRW: 0 };
function decimal(minor, currency) {
  if (minor === null || minor === undefined) return '';
  const digits = DIGITS[currency] ?? 2;
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  if (digits === 0) return `${negative ? '-' : ''}${abs}`;
  const factor = 10n ** BigInt(digits);
  return `${negative ? '-' : ''}${abs / factor}.${String(abs % factor).padStart(digits, '0')}`;
}

/** The export table: header row + one row per transaction (at most MAX_EXPORT). */
async function exportTable(workspaceId, q, { lang = 'en', timezone = 'UTC' } = {}) {
  const rows = (await query(workspaceId, q, { limit: MAX_EXPORT })).map(serialize);
  const word = (w) => (lang === 'ar' && WORDS.ar[w]) || w;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const when = (d) => fmt.format(new Date(d)).replace(',', '');
  return [
    COLUMNS[lang] || COLUMNS.en,
    ...rows.map((t) => [
      when(t.occurredAt), word(t.type), word(t.status), t.orderNumber, t.gateway, t.method || '', word(t.mode || ''),
      decimal(t.amount, t.currency), t.currency, decimal(t.fee, t.feeCurrency || t.currency), t.feeCurrency || '',
      decimal(t.net, t.feeCurrency || t.currency), t.payout ? t.payout.externalId : '', t.payout ? word(t.payout.status) : '',
      t.payout ? t.payout.arrivalDate : '', t.reference || '', t.maskedDisplay || '', t.failureReason || '',
    ]),
  ];
}

// ------------------------------------------------------------------ payouts

function serializePayout(p, counts = {}) {
  return {
    id: p.id,
    gateway: p.provider_code ?? p.providerCode,
    mode: p.mode,
    externalId: p.external_id ?? p.externalId,
    amount: Number(p.amount),
    currency: p.currency,
    fee: Number(p.fee_amount ?? p.feeAmount),
    arrivalDate: p.arrival_date ?? p.arrivalDate,
    status: p.status,
    payments: Number(counts.payments ?? p.payments ?? 0),
    refunds: Number(counts.refunds ?? p.refunds ?? 0),
    unmatchedCount: Number(p.unmatched_count ?? p.unmatchedCount),
    unmatchedAmount: Number(p.unmatched_amount ?? p.unmatchedAmount),
    syncedAt: p.synced_at ?? p.syncedAt,
    createdAt: p.created_at ?? p.createdAt,
  };
}

async function listPayouts(workspaceId, q) {
  const limit = q.limit || 50;
  const where = ['gp.workspace_id = :ws'];
  const r = { ws: workspaceId, limit };
  if (q.gateway) { where.push('gp.provider_code = :gateway'); r.gateway = q.gateway; }
  if (q.status) { where.push('gp.status = :status'); r.status = q.status; }
  if (q.from) { where.push('gp.arrival_date >= :from'); r.from = q.from; }
  if (q.to) { where.push('gp.arrival_date <= :to'); r.to = q.to; }
  if (q.cursor) {
    const [day, id] = String(q.cursor).split('|');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^[0-9a-f-]{36}$/i.test(id || '')) throw new ValidationError([{ field: 'cursor', message: 'Not a cursor from this list' }]);
    where.push("(COALESCE(gp.arrival_date, '9999-12-31'), gp.id) < (:cDay::date, :cId::uuid)");
    r.cDay = day;
    r.cId = id;
  }
  const rows = await db.sequelize.query(
    `SELECT gp.*,
            (SELECT count(*) FROM payments p WHERE p.payout_id = gp.id) AS payments,
            (SELECT count(*) FROM refunds x WHERE x.payout_id = gp.id) AS refunds
       FROM gateway_payouts gp
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(gp.arrival_date, '9999-12-31') DESC, gp.id DESC
      LIMIT :limit`,
    { replacements: r, type: QueryTypes.SELECT }
  );
  const last = rows[rows.length - 1];
  return {
    payouts: rows.map((p) => serializePayout(p)),
    nextCursor: rows.length === limit && last ? `${last.arrival_date || '9999-12-31'}|${last.id}` : null,
  };
}

async function getPayout(workspaceId, payoutId) {
  const payout = await db.GatewayPayout.findOne({ where: { id: payoutId, workspaceId } });
  if (!payout) throw new NotFoundError('Payout');
  const rows = (await query(workspaceId, { payoutId }, { limit: MAX_PAYOUT_LINES })).map(serialize);
  const payments = rows.filter((t) => t.type === 'payment');
  const refunds = rows.filter((t) => t.type === 'refund');
  const sum = (list, k) => list.reduce((n, t) => n + (t[k] || 0), 0);
  return {
    payout: serializePayout(payout.get({ plain: true }), { payments: payments.length, refunds: refunds.length }),
    // What ZIMOS matched: these add up to the payout's amount less its unmatched lines.
    summary: {
      paymentsAmount: sum(payments, 'amount'),
      refundsAmount: sum(refunds, 'amount'),
      fees: sum(rows, 'fee'),
      net: sum(rows, 'net'),
      unmatchedCount: Number(payout.unmatchedCount),
      unmatchedAmount: Number(payout.unmatchedAmount),
    },
    payments,
    refunds,
  };
}

module.exports = { listTransactions, exportTable, listPayouts, getPayout, STATUSES, TYPES };
