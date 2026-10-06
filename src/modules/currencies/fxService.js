'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { convertAmount } = require('../../core/utils/money');
const { recordAudit } = require('../audit/auditService');
const { getRatesAdapter } = require('./adapters');

/**
 * Exchange rates and the store's currency settings (SPEC §11.5).
 *
 * Rates are stored for one pivot base (USD); any pair is derived through it.
 * Amounts are integer minor units on both sides; `convert` scales by each
 * currency's own number of decimals and rounds half-up.
 */

const PIVOT = 'USD';
const STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { display: [], autoConvert: false, useAll: false, symbolPosition: 'auto', decimals: 'auto' };

function minorDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/** Pulls the pivot's rates from the adapter and replaces the stored rows. */
async function refreshRates() {
  const adapter = getRatesAdapter();
  const { rates, fetchedAt } = await adapter.fetchRates({ base: PIVOT });
  const rows = Object.entries(rates)
    .filter(([quote, rate]) => /^[A-Z]{3}$/.test(quote) && Number.isFinite(rate) && rate > 0)
    .map(([quote, rate]) => ({ base: PIVOT, quote, rate: rate.toFixed(8), source: adapter.code, fetchedAt }));
  await db.FxRate.bulkCreate(rows, { updateOnDuplicate: ['rate', 'source', 'fetched_at', 'updated_at'] });
  return { base: PIVOT, source: adapter.code, pairs: rows.length, fetchedAt };
}

/** Refreshes when there are no rates yet or they are older than a day. Never throws. */
async function refreshIfStale() {
  try {
    const newest = await db.FxRate.max('fetchedAt');
    if (newest && Date.now() - new Date(newest).getTime() < STALE_MS) return null;
    return await refreshRates();
  } catch (err) {
    logger.warn('fx.refresh failed; keeping the previous rates', { error: err.message });
    return null;
  }
}

/** { [currency]: units per 1 pivot }, with the pivot itself. */
async function pivotTable(transaction) {
  const rows = await db.FxRate.findAll({ where: { base: PIVOT }, attributes: ['quote', 'rate', 'fetchedAt'], transaction });
  const table = { [PIVOT]: 1 };
  let fetchedAt = null;
  for (const r of rows) {
    table[r.quote] = Number(r.rate);
    if (!fetchedAt || r.fetchedAt > fetchedAt) fetchedAt = r.fetchedAt;
  }
  return { table, fetchedAt };
}

/** Units of `to` per 1 unit of `from`, or null when either currency has no rate. */
async function getRate(from, to, transaction) {
  if (from === to) return 1;
  const { table } = await pivotTable(transaction);
  if (!table[from] || !table[to]) return null;
  return table[to] / table[from];
}

/** `amount` minor units of `from` → minor units of `to` at `rate` (major-unit rate). */
function convertWithRate(amount, from, to, rate) {
  const scaled = rate * 10 ** (minorDigits(to) - minorDigits(from));
  return convertAmount(Number(amount), scaled);
}

async function convert(amount, from, to, transaction) {
  const rate = await getRate(from, to, transaction);
  return rate === null ? null : convertWithRate(amount, from, to, rate);
}

/**
 * What an order records when it is placed: the rate from its currency to the
 * store's base currency and its total in base. Null fields when no rate is
 * known — analytics then fall back to the order's own total.
 */
async function baseFieldsFor(workspaceId, { currency, totalAmount }, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'], transaction });
  const base = (workspace && workspace.defaultCurrency) || currency;
  if (base === currency) return { fxRateToBase: '1.00000000', totalAmountBase: Number(totalAmount) };
  const rate = await getRate(currency, base, transaction);
  if (rate === null) return { fxRateToBase: null, totalAmountBase: null };
  return { fxRateToBase: rate.toFixed(8), totalAmountBase: convertWithRate(totalAmount, currency, base, rate) };
}

// ---------------------------------------------------------------- settings --

function storedSettings(workspace) {
  const stored = (workspace.settings && workspace.settings.currencies) || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Rates from the store's base to each wanted currency: { quote: rate }. */
async function ratesFrom(base, quotes) {
  const { table, fetchedAt } = await pivotTable();
  const rates = {};
  if (table[base]) for (const quote of quotes) if (table[quote] && quote !== base) rates[quote] = Number((table[quote] / table[base]).toFixed(8));
  return { rates, fetchedAt, available: Object.keys(table).sort() };
}

const REPORT_CURRENCIES = ['USD', 'EUR', 'SAR', 'AED', 'MAD', 'EGP'];

async function getForDashboard(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultCurrency', 'settings'] });
  if (!workspace) throw new NotFoundError('Workspace');
  const settings = storedSettings(workspace);
  const base = workspace.defaultCurrency || 'EGP';
  const { rates, fetchedAt, available } = await ratesFrom(base, settings.useAll ? Object.keys((await pivotTable()).table) : settings.display);
  const hasOrders = (await db.Order.count({ where: { workspaceId }, limit: 1 })) > 0;
  // The analytics currency switcher (SPEC §11.5 "EGP / USD / MAD…"): the store's
  // display currencies and a few common ones, for showing report amounts only.
  const report = await ratesFrom(base, [...new Set([...settings.display, ...REPORT_CURRENCIES])]);
  return {
    baseCurrency: base,
    reportRates: report.rates,
    // The account currency cannot change once the store has taken an order.
    baseCurrencyLocked: hasOrders,
    settings,
    rates,
    ratesFetchedAt: fetchedAt,
    availableCurrencies: available,
    provider: getRatesAdapter().code,
  };
}

async function saveSettings(workspaceId, body, req) {
  const { table } = await pivotTable();
  await db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = storedSettings(workspace);
    const next = { ...before, ...body };
    if (body.display) {
      const unknown = body.display.filter((c) => !table[c]);
      if (unknown.length) {
        throw new ValidationError(unknown.map((c) => ({ field: 'display', message: `No exchange rate for ${c}` })), 'Unknown currency');
      }
      next.display = [...new Set(body.display)].filter((c) => c !== workspace.defaultCurrency);
    }
    workspace.settings = { ...(workspace.settings || {}), currencies: next };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'currencies.settings_update', entityType: 'Workspace', entityId: workspaceId,
      before, after: next, req, transaction,
    });
  });
  return getForDashboard(workspaceId);
}

/** What the storefront needs to show converted prices. Display only: orders stay in the base currency. */
async function getForStorefront(workspace) {
  const settings = storedSettings(workspace);
  const base = workspace.defaultCurrency || 'EGP';
  const wanted = settings.useAll ? Object.keys((await pivotTable()).table) : settings.display;
  const { rates, fetchedAt } = await ratesFrom(base, wanted);
  return {
    baseCurrency: base,
    displayCurrencies: Object.keys(rates),
    rates,
    autoConvert: Boolean(settings.autoConvert),
    symbolPosition: settings.symbolPosition,
    decimals: settings.decimals,
    ratesFetchedAt: fetchedAt,
  };
}

module.exports = {
  PIVOT,
  minorDigits,
  refreshRates,
  refreshIfStale,
  getRate,
  convert,
  convertWithRate,
  baseFieldsFor,
  getForDashboard,
  saveSettings,
  getForStorefront,
};
