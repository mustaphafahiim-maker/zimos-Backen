'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const { OrderRejectedError } = require('../fraud/fraudRules');

/**
 * The platform-wide blocklist: phones, emails and addresses a platform admin
 * has blocked from ordering in every workspace.
 *
 * An active match refuses the order outright (orderService.createOrder), in
 * every store and whatever the store's own fraud rules say: storefront and
 * staff orders, COD and online, checkout and funnel upsells alike. The buyer
 * gets the same generic ORDER_REJECTED as any other refusal, and the refusal
 * is audited in the store as `order.blocked` with the `blacklisted_customer`
 * flag and the entry's id and type in the metadata. An expired entry never
 * matches.
 *
 * An order placed before its entry existed is checked again, against what
 * the order stores, at the two steps that turn an unpaid online order into a
 * sale (payments/onlinePaymentService): the shopper switching it to cash on
 * delivery is refused the same way, and a gateway payment landing on it is
 * recorded but the order is cancelled instead of completed.
 *
 * Nothing here writes to a merchant's customers: the customer row is not
 * marked blacklisted, so lifting a platform block leaves no trace behind in
 * any workspace.
 *
 * Entries are platform-level, so their audit rows carry workspace_id NULL.
 */

const TYPES = ['phone', 'email', 'address'];

// The risk flag a platform refusal carries: the store blocklist's own, which
// the dashboard labels "Blocked customer".
const BLOCKED_FLAG = 'blacklisted_customer';

// A whole list is fetched per page; the admin screen pages with limit/offset.
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

const ACTIVE_SQL = '(expires_at IS NULL OR expires_at > NOW())';

function isActive(entry, now = new Date()) {
  return !entry.expiresAt || new Date(entry.expiresAt) > now;
}

function serializeEntry(entry) {
  return {
    id: entry.id,
    type: entry.type,
    value: entry.value,
    label: entry.label,
    reason: entry.reason,
    expiresAt: entry.expiresAt,
    status: isActive(entry) ? 'active' : 'expired',
    createdById: entry.createdByUserId,
    createdBy: entry.createdBy ? entry.createdBy.fullName || entry.createdBy.email : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// What an audit row records about an entry: everything but the author, which
// the audit row's own actor already carries.
function auditState(entry) {
  return {
    type: entry.type,
    value: entry.value,
    label: entry.label,
    reason: entry.reason,
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
  };
}

/** The address's fingerprint, from the one SQL definition (migration 103). */
async function addressFingerprint({ country, city, addressLine }, transaction) {
  const [row] = await db.sequelize.query('SELECT zimos_address_fingerprint($country, $city, $line) AS fingerprint', {
    bind: { country: country || '', city: city || '', line: addressLine || '' },
    type: QueryTypes.SELECT,
    transaction,
  });
  return row.fingerprint;
}

function addressLabel({ country, province, city, addressLine }) {
  return [addressLine, city, province, country]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(', ')
    .slice(0, 600);
}

/**
 * The (value, label) an identifier is stored and matched under. Throws a 422
 * naming the field when the identifier cannot be one (a phone that does not
 * normalize, an address with no street line).
 */
async function normalizeIdentifier({ type, value, address }, transaction) {
  if (type === 'phone') {
    const phone = normalizePhone(value);
    if (!phone) throw new ValidationError([{ field: 'value', message: 'Enter a valid phone number' }]);
    return { value: phone, label: String(value).trim() };
  }
  if (type === 'email') {
    const email = String(value).trim().toLowerCase();
    return { value: email, label: email };
  }
  const fingerprint = await addressFingerprint(address, transaction);
  if (!fingerprint) {
    throw new ValidationError([{ field: 'address', message: 'An address needs a city and a street line' }]);
  }
  return { value: fingerprint, label: addressLabel(address) };
}

function assertFutureExpiry(expiresAt) {
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw new ValidationError([{ field: 'expiresAt', message: 'The expiry must be in the future' }]);
  }
}

const WITH_AUTHOR = [{ model: db.User, as: 'createdBy', attributes: ['id', 'fullName', 'email'], required: false }];

async function listEntries({ type, status = 'all', q, limit = LIST_LIMIT_DEFAULT, offset = 0 } = {}) {
  const where = {};
  if (type) where.type = type;
  if (status === 'active') where[Op.and] = [db.sequelize.literal(ACTIVE_SQL)];
  if (status === 'expired') where.expiresAt = { [Op.lte]: new Date() };
  if (q) {
    const term = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // A phone is searched in its normalized form too, so "010 1234 5678"
    // finds the entry stored as 201012345678.
    const phone = normalizePhone(q);
    where[Op.or] = [
      { label: { [Op.iLike]: term } },
      { reason: { [Op.iLike]: term } },
      { value: { [Op.iLike]: term } },
      ...(phone ? [{ value: phone }] : []),
    ];
  }

  const cappedLimit = Math.min(limit, LIST_LIMIT_MAX);
  const { rows, count } = await db.PlatformBlocklistEntry.findAndCountAll({
    where,
    include: WITH_AUTHOR,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: cappedLimit,
    offset,
  });
  return { entries: rows.map(serializeEntry), total: count, limit: cappedLimit, offset };
}

/** The entry, row-locked for the rest of the transaction. No include: Postgres
 *  refuses FOR UPDATE on the nullable side of the author's outer join. */
async function lockEntry(entryId, transaction) {
  const entry = await db.PlatformBlocklistEntry.findByPk(entryId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!entry) throw new NotFoundError('Blocklist entry');
  return entry;
}

async function withAuthor(entryId, transaction) {
  return db.PlatformBlocklistEntry.findByPk(entryId, { include: WITH_AUTHOR, transaction });
}

/**
 * Blocks an identifier. Blocking one that is already on the list (active or
 * lapsed) updates its reason and expiry instead of failing — the same
 * convention as the workspace blocklist's POST: `created` says which it was,
 * and the controller answers 201 or 200 accordingly.
 */
async function blockIdentifier(input, req) {
  assertFutureExpiry(input.expiresAt);
  return db.sequelize.transaction(async (transaction) => {
    const { value, label } = await normalizeIdentifier(input, transaction);
    const fields = { reason: input.reason, expiresAt: input.expiresAt || null };

    // Serializes two admins blocking the same identifier at once, so exactly
    // one of them creates the row and the other updates it.
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended($key, 0))', {
      bind: { key: `platform_blocklist:${input.type}:${value}` },
      transaction,
    });

    const existing = await db.PlatformBlocklistEntry.findOne({ where: { type: input.type, value }, transaction });
    if (existing) {
      const before = auditState(existing);
      await existing.update(fields, { transaction });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'platform_blocklist.update',
        entityType: 'PlatformBlocklistEntry',
        entityId: existing.id,
        before,
        after: auditState(existing),
        metadata: input.source ? { source: input.source } : null,
        req,
        transaction,
      });
      return { created: false, entry: serializeEntry(await withAuthor(existing.id, transaction)) };
    }

    const entry = await db.PlatformBlocklistEntry.create(
      { type: input.type, value, label, ...fields, createdByUserId: req.user.id },
      { transaction }
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: 'platform_blocklist.create',
      entityType: 'PlatformBlocklistEntry',
      entityId: entry.id,
      after: auditState(entry),
      metadata: input.source ? { source: input.source } : null,
      req,
      transaction,
    });
    return { created: true, entry: serializeEntry(await withAuthor(entry.id, transaction)) };
  });
}

/** Changes the reason and/or the expiry. The identifier itself is fixed. */
async function updateEntry(entryId, input, req) {
  if (input.expiresAt !== undefined) assertFutureExpiry(input.expiresAt);
  return db.sequelize.transaction(async (transaction) => {
    const entry = await lockEntry(entryId, transaction);
    const before = auditState(entry);
    const fields = {};
    if (input.reason !== undefined) fields.reason = input.reason;
    if (input.expiresAt !== undefined) fields.expiresAt = input.expiresAt || null;
    await entry.update(fields, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'platform_blocklist.update',
      entityType: 'PlatformBlocklistEntry',
      entityId: entry.id,
      before,
      after: auditState(entry),
      req,
      transaction,
    });
    return serializeEntry(await withAuthor(entry.id, transaction));
  });
}

async function deleteEntry(entryId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const entry = await lockEntry(entryId, transaction);
    const before = auditState(entry);
    await entry.destroy({ transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'platform_blocklist.delete',
      entityType: 'PlatformBlocklistEntry',
      entityId: entryId,
      before,
      req,
      transaction,
    });
    return { success: true };
  });
}

/**
 * The first active platform entry an order's identifiers hit, or null. One
 * query, run inside the caller's transaction (createOrder's, or a payment
 * being recorded — see findActiveMatchForOrder):
 *
 *   phone    the customer's normalized phone (the same value the workspace
 *            blocklist is keyed on)
 *   email    the contact email, trimmed and lowercased
 *   address  the shipping address's fingerprint, computed in SQL by the same
 *            function the admin's block used
 *
 * Returns { id, type } — enough to trace the hit, nothing about the reason.
 */
async function findActiveMatch({ phoneNormalized, email, shippingAddress }, transaction) {
  const arms = [];
  const bind = {};
  if (phoneNormalized) {
    arms.push("(type = 'phone' AND value = $phone)");
    bind.phone = phoneNormalized;
  }
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (cleanEmail) {
    arms.push("(type = 'email' AND value = $email)");
    bind.email = cleanEmail;
  }
  if (shippingAddress && shippingAddress.city && shippingAddress.addressLine) {
    arms.push("(type = 'address' AND value = zimos_address_fingerprint($country, $city, $line))");
    bind.country = shippingAddress.country || '';
    bind.city = shippingAddress.city;
    bind.line = shippingAddress.addressLine;
  }
  if (arms.length === 0) return null;

  const rows = await db.sequelize.query(
    `SELECT id, type
       FROM platform_blocklist_entries
      WHERE ${ACTIVE_SQL}
        AND (${arms.join(' OR ')})
      ORDER BY created_at ASC
      LIMIT 1`,
    { bind, type: QueryTypes.SELECT, transaction }
  );
  return rows[0] || null;
}

/**
 * findActiveMatch for an order that already exists, on what the order stores
 * now: the phone and email of its contact snapshot and its shipping address
 * (as corrected, if the merchant corrected it). The phone normalizes to the
 * value its customer row was found by at checkout.
 */
async function findActiveMatchForOrder(order, transaction) {
  const contact = order.contactSnapshot || {};
  return findActiveMatch(
    { phoneNormalized: normalizePhone(contact.phone), email: contact.email, shippingAddress: order.shippingAddressSnapshot },
    transaction
  );
}

/** What the buyer gets for a match: the generic ORDER_REJECTED, naming nothing. */
function rejection(customerId, match) {
  return new OrderRejectedError({ customerId, flags: [BLOCKED_FLAG], platformBlock: match });
}

/** Audit metadata naming the entry a refusal hit: its id and type, never its value or reason. */
function auditMetadata(match) {
  return { platformBlocklist: { entryId: match.id, type: match.type } };
}

/**
 * The store's `order.blocked` row for an existing order a match stopped from
 * becoming a sale. `on` names the step ('switch_to_cod', 'payment'), as the
 * store's own switch-to-COD refusal does. The actor is the staff member when
 * one made the request; a shopper or a gateway callback has none.
 */
async function recordOrderBlocked(order, match, { on, req = null, transaction = null }) {
  logger.warn('Order refused by the platform blocklist', {
    workspaceId: order.workspaceId,
    orderId: order.id,
    on,
    platformBlocklistEntryId: match.id,
  });
  await recordAudit({
    workspaceId: order.workspaceId,
    actorUserId: req && req.user ? req.user.id : null,
    action: 'order.blocked',
    entityType: 'Order',
    entityId: order.id,
    after: { flags: [BLOCKED_FLAG], on },
    metadata: auditMetadata(match),
    req,
    transaction,
  });
}

/**
 * Which of these normalized values are actively blocked, for one type — the
 * risk signals list marks its rows with it. Returns a value -> entry id map.
 */
async function activeEntriesFor(type, values) {
  if (!TYPES.includes(type)) throw new AppError('INVALID_TYPE', `Unknown identifier type "${type}"`, 422);
  if (values.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT id, value FROM platform_blocklist_entries
      WHERE type = $type AND value = ANY($values::text[]) AND ${ACTIVE_SQL}`,
    { bind: { type, values }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.value, r.id]));
}

module.exports = {
  TYPES,
  BLOCKED_FLAG,
  LIST_LIMIT_MAX,
  listEntries,
  blockIdentifier,
  updateEntry,
  deleteEntry,
  findActiveMatch,
  findActiveMatchForOrder,
  rejection,
  auditMetadata,
  recordOrderBlocked,
  activeEntriesFor,
  addressFingerprint,
};
