'use strict';

const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const gateways = require('./gateways/registry');

/**
 * The ways a merchant can pay Zimos (payment_methods, migration 130).
 *
 *   manual   a transfer (InstaPay, a mobile wallet) to the number on the row,
 *            proved with a screenshot a platform admin checks
 *            (paymentProofService). Offered while enabled; it can't be
 *            enabled without its number. EGP only: that is what they move.
 *   gateway  a hosted checkout through an adapter (gateways/registry) with
 *            the same code. Offered while its row is enabled AND the adapter
 *            says it is configured from the environment — for Fawaterak,
 *            ONLINE_BILLING_ENABLED and its keys, as the Pay button has
 *            always required.
 *
 * The table never holds a secret. Turning a method on or off and their
 * order need payment_methods.manage; a manual method's number and note need
 * payment_methods.edit_numbers. Both are the creator's ('*') unless granted.
 */

const MANUAL_CURRENCY = 'EGP';

function adapterOf(row) {
  return row.kind === 'gateway' ? gateways.get(row.code) : null;
}

/** Whether a merchant paying in `currency` is offered this row now. */
function offered(row, currency) {
  if (!row.enabled) return false;
  if (row.kind === 'manual') return Boolean(row.accountNumber) && currency === MANUAL_CURRENCY;
  const adapter = adapterOf(row);
  return Boolean(adapter) && adapter.canStart() && (!currency || adapter.currencies.includes(currency));
}

async function enabledRows(where = {}) {
  return db.PaymentMethod.findAll({
    where: { enabled: true, ...where },
    order: [
      ['sortOrder', 'ASC'],
      ['code', 'ASC'],
    ],
  });
}

/** The adapter of a gateway a merchant may start a payment with, or null. */
async function offeredGateway(code) {
  const row = await db.PaymentMethod.findOne({ where: { code: String(code), kind: 'gateway', enabled: true } });
  return row && offered(row) ? adapterOf(row) : null;
}

/** An enabled manual method with its number, or null. */
async function offeredManual(code) {
  const row = await db.PaymentMethod.findOne({ where: { code: String(code), kind: 'manual', enabled: true } });
  return row && row.accountNumber ? row : null;
}

function serializeForMerchant(row) {
  return {
    code: row.code,
    kind: row.kind,
    label: { ar: row.labelAr, en: row.labelEn },
    ...(row.kind === 'manual'
      ? {
          accountNumber: row.accountNumber,
          // Null when the console left it empty: no link is shown.
          paymentLink: row.paymentLink || null,
          note: { ar: row.noteAr || null, en: row.noteEn || null },
        }
      : {}),
  };
}

/**
 * GET /workspaces/:id/billing/payment-methods — what this store can pay its
 * charges with right now, in the console's order. None: contact support.
 */
async function listForWorkspace(workspaceId) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan' }] });
  if (!subscription) throw new NotFoundError('Subscription');
  const currency = subscription.plan ? subscription.plan.currency : MANUAL_CURRENCY;
  const methods = (await enabledRows()).filter((row) => offered(row, currency)).map(serializeForMerchant);
  return { methods, currency, contactSupport: methods.length === 0 };
}

/** Whether any way to pay a charge in `currency` is offered. */
async function anyOffered(currency) {
  return (await enabledRows()).some((row) => offered(row, currency));
}

// ---------------------------------------------------------------- console

function serializeForAdmin(row) {
  const adapter = adapterOf(row);
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    labelAr: row.labelAr,
    labelEn: row.labelEn,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    ...(row.kind === 'manual'
      ? { accountNumber: row.accountNumber, paymentLink: row.paymentLink || null, noteAr: row.noteAr, noteEn: row.noteEn }
      : {
          gateway: {
            name: adapter ? adapter.name : null,
            // Whether this server has an adapter for the code at all.
            adapterInstalled: Boolean(adapter),
            // Configured in the environment, by variable names only.
            configured: adapter ? adapter.canStart() : false,
            missing: adapter ? adapter.missing() : [],
            currencies: adapter ? adapter.currencies : [],
          },
        }),
    offered: offered(row, row.kind === 'manual' ? MANUAL_CURRENCY : null),
    updatedAt: row.updatedAt,
  };
}

/**
 * GET /admin/payment-methods — every row, and every gateway this server has
 * an adapter for that has no row yet (so it can be turned on).
 */
async function listForAdmin() {
  const rows = await db.PaymentMethod.findAll({
    order: [
      ['sortOrder', 'ASC'],
      ['code', 'ASC'],
    ],
  });
  const known = new Set(rows.map((r) => r.code));
  const notAdded = gateways
    .all()
    .filter((adapter) => !known.has(adapter.code))
    .map((adapter) => ({
      code: adapter.code,
      name: adapter.name,
      configured: adapter.canStart(),
      missing: adapter.missing(),
      currencies: adapter.currencies,
    }));
  return { methods: rows.map(serializeForAdmin), gatewaysNotAdded: notAdded };
}

const auditState = (row) => ({
  enabled: row.enabled,
  sortOrder: row.sortOrder,
  labelAr: row.labelAr,
  labelEn: row.labelEn,
  ...(row.kind === 'manual' ? { accountNumber: row.accountNumber, paymentLink: row.paymentLink, noteAr: row.noteAr, noteEn: row.noteEn } : {}),
});

/**
 * PATCH /admin/payment-methods/:code — on or off, and the labels. A gateway
 * with an adapter but no row yet gets its row here. A manual method can't be
 * turned on without its number (409).
 */
async function updateMethod(code, { enabled, labelAr, labelEn }, req) {
  return db.sequelize.transaction(async (transaction) => {
    let row = await db.PaymentMethod.findOne({ where: { code }, transaction, lock: transaction.LOCK.UPDATE });
    let created = false;
    if (!row) {
      const adapter = gateways.get(code);
      if (!adapter) throw new NotFoundError('Payment method');
      const last = await db.PaymentMethod.max('sortOrder', { transaction });
      row = await db.PaymentMethod.create(
        {
          kind: 'gateway',
          code,
          labelAr: labelAr || adapter.name,
          labelEn: labelEn || adapter.name,
          sortOrder: (Number(last) || 0) + 10,
          enabled: false,
        },
        { transaction }
      );
      created = true;
    }
    const before = created ? null : auditState(row);
    const changes = {};
    if (enabled !== undefined) changes.enabled = enabled;
    if (labelAr !== undefined) changes.labelAr = labelAr;
    if (labelEn !== undefined) changes.labelEn = labelEn;
    if (changes.enabled && row.kind === 'manual' && !row.accountNumber) {
      throw new ConflictError('Set the number this method sends money to before turning it on.', 'PAYMENT_METHOD_NEEDS_NUMBER');
    }
    await row.update(changes, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: created ? 'payment_method.add' : 'payment_method.update',
      entityType: 'PaymentMethod',
      entityId: row.id,
      before,
      after: auditState(row),
      metadata: { code: row.code, kind: row.kind },
      req,
      transaction,
    });
    return serializeForAdmin(row);
  });
}

/** PUT /admin/payment-methods/order — the codes, first shown first. Codes left out keep their place after them. */
async function reorder(codes, req) {
  return db.sequelize.transaction(async (transaction) => {
    const rows = await db.PaymentMethod.findAll({ where: { code: codes }, transaction, lock: transaction.LOCK.UPDATE });
    if (rows.length !== new Set(codes).size) throw new AppError('UNKNOWN_PAYMENT_METHOD', 'Every code must be a payment method.', 422);
    const before = Object.fromEntries(rows.map((r) => [r.code, r.sortOrder]));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const [index, code] of [...new Set(codes)].entries()) {
      await byCode.get(code).update({ sortOrder: (index + 1) * 10 }, { transaction });
    }
    await recordAudit({
      actorUserId: req.user.id,
      action: 'payment_method.reorder',
      entityType: 'PaymentMethod',
      before,
      after: Object.fromEntries(rows.map((r) => [r.code, r.sortOrder])),
      req,
      transaction,
    });
    return listForAdmin();
  });
}

/**
 * PATCH /admin/payment-methods/:code/account — a manual method's number and
 * note (payment_methods.edit_numbers). Audited with the old and new values.
 * The number can't be cleared while the method is on.
 */
async function updateManualDetails(code, { accountNumber, paymentLink, noteAr, noteEn }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await db.PaymentMethod.findOne({ where: { code }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw new NotFoundError('Payment method');
    if (row.kind !== 'manual') {
      throw new ConflictError('Only a manual method has a number. A gateway is set up in the environment.', 'NOT_A_MANUAL_METHOD');
    }
    const changes = {};
    if (accountNumber !== undefined) changes.accountNumber = accountNumber || null;
    if (paymentLink !== undefined) changes.paymentLink = paymentLink || null;
    if (noteAr !== undefined) changes.noteAr = noteAr || null;
    if (noteEn !== undefined) changes.noteEn = noteEn || null;
    if (row.enabled && changes.accountNumber === null) {
      throw new ConflictError('Turn this method off before removing its number.', 'PAYMENT_METHOD_NEEDS_NUMBER');
    }
    const before = { accountNumber: row.accountNumber, paymentLink: row.paymentLink, noteAr: row.noteAr, noteEn: row.noteEn };
    await row.update(changes, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'payment_method.account_update',
      entityType: 'PaymentMethod',
      entityId: row.id,
      before,
      after: { accountNumber: row.accountNumber, paymentLink: row.paymentLink, noteAr: row.noteAr, noteEn: row.noteEn },
      metadata: { code: row.code },
      req,
      transaction,
    });
    return serializeForAdmin(row);
  });
}

module.exports = {
  MANUAL_CURRENCY,
  offeredGateway,
  offeredManual,
  listForWorkspace,
  anyOffered,
  listForAdmin,
  updateMethod,
  reorder,
  updateManualDetails,
};
