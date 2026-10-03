'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../orders/orderStage');
const { resolveWindow } = require('../analytics/overviewService');
const { PLATFORM_OF_SOURCE } = require('../analytics/attributionService');

/**
 * Ad spend per day (SPEC §15.4): manual entry, CSV import and the campaigns
 * report that sets spend against real, delivered orders. Spend is recorded in
 * the store's currency.
 */

const PLATFORMS = ['meta', 'tiktok', 'snapchat', 'google', 'other'];
const MAX_IMPORT_ROWS = 5000;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const campaignKey = (name) => String(name).trim().toLowerCase();

function serialize(r) {
  return {
    id: r.id,
    day: r.day,
    platform: r.platform,
    campaignName: r.campaignName,
    campaignId: r.campaignId,
    spendAmount: Number(r.spendAmount),
    currency: r.currency,
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    source: r.source,
    createdAt: r.createdAt,
  };
}

async function storeCurrency(workspaceId) {
  const ws = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'] });
  return (ws && ws.defaultCurrency) || 'EGP';
}

async function list(workspaceId, { from, to, platform, limit = 200, offset = 0 } = {}) {
  const where = { workspaceId };
  if (from || to) where.day = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  if (platform) where.platform = platform;
  const { rows, count } = await db.AdSpendDaily.findAndCountAll({
    where,
    order: [['day', 'DESC'], ['platform', 'ASC'], ['campaignKey', 'ASC']],
    limit,
    offset,
  });
  const total = await db.AdSpendDaily.sum('spendAmount', { where });
  return { entries: rows.map(serialize), total: count, totalSpendAmount: Number(total || 0), currency: await storeCurrency(workspaceId) };
}

/** Insert, or replace the amount of the same (day, platform, campaign). */
async function upsertOne(workspaceId, entry, { source, userId, currency, transaction }) {
  const key = campaignKey(entry.campaignName);
  const values = {
    campaignName: String(entry.campaignName).trim(),
    campaignId: entry.campaignId || null,
    spendAmount: entry.spendAmount,
    impressions: entry.impressions ?? null,
    clicks: entry.clicks ?? null,
    currency,
    source,
  };
  const existing = await db.AdSpendDaily.findOne({
    where: { workspaceId, day: entry.day, platform: entry.platform, campaignKey: key },
    transaction,
  });
  if (existing) return { row: await existing.update(values, { transaction }), created: false };
  const row = await db.AdSpendDaily.create(
    { workspaceId, day: entry.day, platform: entry.platform, campaignKey: key, createdByUserId: userId || null, ...values },
    { transaction }
  );
  return { row, created: true };
}

async function create(workspaceId, body, req) {
  const currency = await storeCurrency(workspaceId);
  const { row, created } = await upsertOne(workspaceId, body, { source: 'manual', userId: req.user.id, currency });
  await recordAudit({
    workspaceId, actorUserId: req.user.id, action: created ? 'ad_spend.create' : 'ad_spend.update',
    entityType: 'AdSpendDaily', entityId: row.id, after: serialize(row), req,
  });
  return serialize(row);
}

async function update(workspaceId, id, body, req) {
  const row = await db.AdSpendDaily.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Ad spend entry');
  const before = serialize(row);
  const patch = {};
  for (const f of ['spendAmount', 'impressions', 'clicks', 'campaignId']) if (body[f] !== undefined) patch[f] = body[f];
  await row.update(patch);
  await recordAudit({
    workspaceId, actorUserId: req.user.id, action: 'ad_spend.update', entityType: 'AdSpendDaily', entityId: row.id, before, after: serialize(row), req,
  });
  return serialize(row);
}

async function remove(workspaceId, id, req) {
  const row = await db.AdSpendDaily.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Ad spend entry');
  const before = serialize(row);
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'ad_spend.delete', entityType: 'AdSpendDaily', entityId: id, before, req });
  return { deleted: true };
}

// ------------------------------------------------------------------- CSV --

/** RFC-4180-ish: quoted fields, doubled quotes, comma or semicolon, CRLF. */
function parseCsv(text) {
  const clean = String(text).replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER_ALIASES = {
  day: ['date', 'day', 'reporting starts', 'التاريخ', 'اليوم'],
  platform: ['platform', 'channel', 'المنصة'],
  campaignName: ['campaign name', 'campaign', 'campaign_name', 'اسم الحملة', 'الحملة'],
  spend: ['spend', 'amount spent', 'cost', 'amount', 'الإنفاق', 'المبلغ'],
  impressions: ['impressions', 'مرات الظهور'],
  clicks: ['clicks', 'link clicks', 'النقرات'],
  campaignId: ['campaign id', 'campaign_id'],
};
const PLATFORM_ALIASES = { ...PLATFORM_OF_SOURCE, snap: 'snapchat', 'google ads': 'google', adwords: 'google' };

/** "1,234.50" / "1234,5" / "١٢٣" → integer minor units, or null. */
function parseSpend(raw, digits) {
  let s = String(raw).trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot && s.length - lastComma <= 3) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const value = Number(s);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10 ** digits);
}

/** YYYY-MM-DD, or DD/MM/YYYY (the Egyptian order), → YYYY-MM-DD, or null. */
function parseDay(raw) {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let parts = m ? [m[1], m[2], m[3]] : null;
  if (!parts) {
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) parts = [m[3], m[2], m[1]];
  }
  if (!parts) return null;
  const [y, mo, d] = parts.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/**
 * Imports `date, platform, campaign name, spend[, impressions, clicks]`.
 * Valid rows are saved (replacing the same day/platform/campaign); the rest
 * come back as an error report with their line numbers. `defaultPlatform`
 * fills in a file exported from one ads manager, which has no platform column.
 */
async function importCsv(workspaceId, { csv, defaultPlatform, dryRun = false }, req) {
  const table = parseCsv(csv);
  if (table.length < 2) throw new ValidationError([{ field: 'csv', message: 'The file has no data rows' }], 'Nothing to import');
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    throw new ValidationError([{ field: 'csv', message: `At most ${MAX_IMPORT_ROWS} rows per import` }], 'File too large');
  }
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [field, names] of Object.entries(HEADER_ALIASES)) col[field] = header.findIndex((h) => names.includes(h));
  const missing = ['day', 'campaignName', 'spend'].filter((f) => col[f] < 0);
  if (col.platform < 0 && !defaultPlatform) missing.push('platform');
  if (missing.length) {
    throw new ValidationError(
      missing.map((f) => ({ field: f, message: `Column not found: ${HEADER_ALIASES[f][0]}` })),
      'The file is missing required columns'
    );
  }
  const currency = await storeCurrency(workspaceId);
  const digits = currencyDigits(currency);
  const errors = [];
  const valid = [];
  const cell = (row, field) => (col[field] >= 0 ? (row[col[field]] || '').trim() : '');
  const int = (v) => (v === '' ? null : Number.isFinite(Number(v.replace(/,/g, ''))) ? Math.round(Number(v.replace(/,/g, ''))) : null);
  table.slice(1).forEach((row, i) => {
    const line = i + 2;
    const day = parseDay(cell(row, 'day'));
    const rawPlatform = (cell(row, 'platform') || defaultPlatform || '').toLowerCase();
    const platform = PLATFORM_ALIASES[rawPlatform] || (PLATFORMS.includes(rawPlatform) ? rawPlatform : null);
    const campaignName = cell(row, 'campaignName').slice(0, 200);
    const spendAmount = parseSpend(cell(row, 'spend'), digits);
    const problems = [];
    if (!day) problems.push('date');
    if (!platform) problems.push('platform');
    if (!campaignName) problems.push('campaign name');
    if (spendAmount === null) problems.push('spend');
    if (problems.length) errors.push({ line, problems });
    else {
      valid.push({
        day, platform, campaignName, spendAmount,
        impressions: int(cell(row, 'impressions')), clicks: int(cell(row, 'clicks')),
        campaignId: cell(row, 'campaignId') || null,
      });
    }
  });

  let created = 0;
  let updated = 0;
  if (!dryRun && valid.length) {
    await db.sequelize.transaction(async (transaction) => {
      for (const entry of valid) {
        const result = await upsertOne(workspaceId, entry, { source: 'csv', userId: req.user.id, currency, transaction });
        if (result.created) created += 1;
        else updated += 1;
      }
      await recordAudit({
        workspaceId, actorUserId: req.user.id, action: 'ad_spend.import', entityType: 'AdSpendDaily',
        after: { created, updated, rejected: errors.length }, req, transaction,
      });
    });
  }
  return {
    dryRun,
    rows: table.length - 1,
    valid: valid.length,
    created,
    updated,
    totalSpendAmount: valid.reduce((n, v) => n + v.spendAmount, 0),
    currency,
    errors: errors.slice(0, 200),
    errorCount: errors.length,
  };
}

// -------------------------------------------------------------- campaigns --

/**
 * Campaigns: spend against the orders their UTM campaign brought, with the
 * real cost per delivered order and the real return on spend. An order is
 * matched when its purchase event's utm_campaign equals the campaign's name or
 * its id (case-insensitive).
 */
async function campaigns(workspaceId, query = {}) {
  const { start, end } = resolveWindow({ from: query.from, to: query.to });
  const ws = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const tz = (ws && ws.timezone) || 'UTC';
  const replacements = { workspaceId, start, end, tz };
  const run = (sql) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
  const [spend, orders] = await Promise.all([
    run(`SELECT platform, campaign_key, max(campaign_name) AS name, max(lower(campaign_id)) AS campaign_id,
                sum(spend_amount) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
                min(day) AS first_day, max(day) AS last_day
           FROM ad_spend_daily
          WHERE workspace_id = :workspaceId
            AND day >= (:start AT TIME ZONE :tz)::date AND day <= ((:end::timestamptz - interval '1 second') AT TIME ZONE :tz)::date
          GROUP BY platform, campaign_key`),
    run(`WITH ord AS (
           SELECT o.total_amount, ${STAGE_SQL} AS stage,
                  (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected') AS live,
                  (o.confirmation_state = 'confirmed') AS confirmed,
                  lower(p.campaign) AS campaign
             FROM orders o${LATEST_SHIPMENT_JOIN}
             JOIN LATERAL (
               SELECT e.campaign FROM analytics_events e
                WHERE e.workspace_id = o.workspace_id AND e.order_id = o.id AND e.event_name = 'purchase'
                  AND coalesce(e.campaign, '') <> ''
                ORDER BY e.created_at LIMIT 1
             ) p ON TRUE
            WHERE o.workspace_id = :workspaceId AND o.created_at >= :start AND o.created_at < :end AND ${countsAsSaleSql('o')})
         SELECT campaign, count(*) AS orders, count(*) FILTER (WHERE confirmed) AS confirmed,
                count(*) FILTER (WHERE stage = 'delivered') AS delivered,
                count(*) FILTER (WHERE stage = 'returned') AS returned,
                coalesce(sum(total_amount) FILTER (WHERE live), 0) AS sales,
                coalesce(sum(total_amount) FILTER (WHERE stage = 'delivered'), 0) AS delivered_sales
           FROM ord GROUP BY campaign`),
  ]);
  const byCampaign = new Map(orders.map((r) => [r.campaign, r]));
  const matched = new Set();
  const rows = spend.map((s) => {
    const o = byCampaign.get(s.campaign_key) || (s.campaign_id && byCampaign.get(s.campaign_id)) || {};
    if (o.campaign) matched.add(o.campaign);
    const spendAmount = Number(s.spend);
    const delivered = Number(o.delivered || 0);
    const deliveredSales = Number(o.delivered_sales || 0);
    return {
      platform: s.platform,
      campaignName: s.name,
      campaignId: s.campaign_id,
      firstDay: s.first_day,
      lastDay: s.last_day,
      spendAmount,
      impressions: num(s.impressions),
      clicks: num(s.clicks),
      orders: Number(o.orders || 0),
      confirmed: Number(o.confirmed || 0),
      delivered,
      returned: Number(o.returned || 0),
      salesAmount: Number(o.sales || 0),
      deliveredSalesAmount: deliveredSales,
      costPerOrder: Number(o.orders || 0) > 0 ? Math.round(spendAmount / Number(o.orders)) : null,
      // Real CPA: spend ÷ delivered orders. Real ROAS: delivered sales ÷ spend.
      realCpa: delivered > 0 ? Math.round(spendAmount / delivered) : null,
      realRoas: spendAmount > 0 ? Math.round((deliveredSales / spendAmount) * 100) / 100 : null,
    };
  });
  rows.sort((a, b) => b.spendAmount - a.spendAmount);
  // Campaigns that brought orders but have no spend recorded: the merchant should add it.
  const withoutSpend = orders
    .filter((o) => !matched.has(o.campaign))
    .map((o) => ({ campaign: o.campaign, orders: Number(o.orders), delivered: Number(o.delivered), salesAmount: Number(o.sales) }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 50);
  const sum = (f) => rows.reduce((n, r) => n + (r[f] || 0), 0);
  const spendTotal = sum('spendAmount');
  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone: tz },
    currency: (ws && ws.defaultCurrency) || 'EGP',
    totals: {
      spendAmount: spendTotal,
      orders: sum('orders'),
      delivered: sum('delivered'),
      deliveredSalesAmount: sum('deliveredSalesAmount'),
      realCpa: sum('delivered') > 0 ? Math.round(spendTotal / sum('delivered')) : null,
      realRoas: spendTotal > 0 ? Math.round((sum('deliveredSalesAmount') / spendTotal) * 100) / 100 : null,
    },
    campaigns: rows,
    withoutSpend,
    // Paste after the ad's URL so orders can be matched to the campaign by name.
    suggestedUrlParameters: {
      meta: 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&ad_id={{ad.id}}',
      tiktok: 'utm_source=tiktok&utm_medium=paid&utm_campaign=__CAMPAIGN_NAME__&utm_content=__CID_NAME__&ad_id=__CID__',
      snapchat: 'utm_source=snapchat&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&ad_id={{ad.id}}',
      google: 'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}',
    },
  };
}

module.exports = { list, create, update, remove, importCsv, campaigns, upsertOne, storeCurrency, PLATFORMS, parseCsv, parseSpend, parseDay };
