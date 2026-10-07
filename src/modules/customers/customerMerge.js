'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Merge duplicate customers (spec-gaps item 248) — the same person under two
 * phone numbers or a typo. The team picks the one to keep; in one
 * transaction:
 *   - every row that points at the duplicate (orders, addresses, notes,
 *     reviews, wishlist, referrals, loyalty and credit ledgers, … — found
 *     from the database's foreign keys, so a new table is covered too) is
 *     pointed at the kept customer; where the kept one already has the same
 *     thing (a review of the same product, the same wishlist item, a course
 *     enrolment, a referral code) the duplicate's copy is dropped;
 *   - points and store credit are added together, with one ledger line each
 *     (kind `merge`);
 *   - name, email, company, tax ID fill gaps on the kept customer; the
 *     duplicate's phone becomes the alternate phone when there is none; tags
 *     and saved addresses are joined; marketing consent and the blacklist
 *     flag are kept if either had them; order counters are added;
 *   - the duplicate is deleted and the kept customer's sign-ins restart.
 * Refused while either has an online payment in progress.
 */

// Unique rules on customer-linked tables: drop the duplicate's copy first.
const CONFLICTS = [
  `DELETE FROM reviews r USING reviews k WHERE r.customer_id = :src AND k.customer_id = :dst AND k.product_id = r.product_id AND k.workspace_id = r.workspace_id`,
  `DELETE FROM enrollments r USING enrollments k WHERE r.customer_id = :src AND k.customer_id = :dst AND k.course_id = r.course_id`,
  `DELETE FROM wishlist_items r USING wishlist_items k WHERE r.customer_id = :src AND k.customer_id = :dst AND k.product_id = r.product_id
     AND COALESCE(k.variant_id, '00000000-0000-0000-0000-000000000000') = COALESCE(r.variant_id, '00000000-0000-0000-0000-000000000000')`,
  `DELETE FROM customer_referral_codes WHERE customer_id = :src AND EXISTS (SELECT 1 FROM customer_referral_codes WHERE customer_id = :dst)`,
  // Sign-in codes are the duplicate's, for its own phone: they go.
  `DELETE FROM shopper_login_codes WHERE customer_id = :src`,
];

async function foreignKeys(transaction) {
  return db.sequelize.query(
    `SELECT cl.relname AS tbl, a.attname AS col
       FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'customers'::regclass`,
    { type: QueryTypes.SELECT, transaction }
  );
}

async function paymentInProgress(ids, transaction) {
  const [r] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE customer_id IN (:ids) AND cancelled_at IS NULL
        AND payment_expires_at IS NOT NULL AND payment_expires_at > now() AND financial_state NOT IN ('paid', 'refunded', 'partially_refunded')`,
    { replacements: { ids }, type: QueryTypes.SELECT, transaction }
  );
  return r.n > 0;
}

async function merge(workspaceId, keepId, duplicateId, req) {
  if (keepId === duplicateId) throw new ValidationError([{ field: 'duplicateId', message: 'Pick two different customers' }]);
  return db.sequelize.transaction(async (transaction) => {
    const [keep, dup] = await Promise.all([keepId, duplicateId].map((id) => db.Customer.findOne({ where: { id, workspaceId }, transaction, lock: transaction.LOCK.UPDATE })));
    if (!keep || !dup) throw new NotFoundError('Customer');
    if (await paymentInProgress([keep.id, dup.id], transaction)) throw new AppError('CUSTOMER_PAYMENT_IN_PROGRESS', 'One of them has an online payment in progress; try again once it is done', 409);
    const repl = { src: dup.id, dst: keep.id };
    for (const sql of CONFLICTS) await db.sequelize.query(sql, { replacements: repl, transaction });
    const moved = {};
    for (const { tbl, col } of await foreignKeys(transaction)) {
      const [, meta] = await db.sequelize.query(`UPDATE "${tbl}" SET "${col}" = :dst WHERE "${col}" = :src`, { replacements: repl, transaction });
      const n = typeof meta === 'number' ? meta : (meta && meta.rowCount) || 0;
      if (n) moved[`${tbl}.${col}`] = n;
    }

    const points = Number(dup.loyaltyPoints) || 0;
    const credit = Number(dup.storeCreditAmount) || 0;
    const tags = [...new Set([...(keep.tags || []), ...(dup.tags || [])])].slice(0, 50);
    const addresses = [...(keep.savedAddresses || []), ...(dup.savedAddresses || [])].slice(0, 20);
    await keep.update({
      fullName: keep.fullName || dup.fullName,
      email: keep.email || dup.email,
      // The email's verification travels with it (item 278).
      emailVerifiedAt: keep.email ? keep.emailVerifiedAt : dup.emailVerifiedAt,
      alternatePhone: keep.alternatePhone || dup.phoneRaw || dup.phoneNormalized,
      companyName: keep.companyName || dup.companyName,
      taxId: keep.taxId || dup.taxId,
      tags,
      savedAddresses: addresses,
      marketingConsent: keep.marketingConsent || dup.marketingConsent,
      isBlacklisted: keep.isBlacklisted || dup.isBlacklisted,
      blacklistReason: keep.blacklistReason || dup.blacklistReason,
      totalOrders: (keep.totalOrders || 0) + (dup.totalOrders || 0),
      totalRejectedOrders: (keep.totalRejectedOrders || 0) + (dup.totalRejectedOrders || 0),
      loyaltyPoints: Number(keep.loyaltyPoints) + points,
      storeCreditAmount: Number(keep.storeCreditAmount) + credit,
      accountVersion: (keep.accountVersion || 1) + 1,
    }, { transaction, hooks: false });
    const note = `Merged from ${dup.fullName || ''} ${dup.phoneRaw || dup.phoneNormalized}`.trim().slice(0, 200);
    if (points) await db.LoyaltyTransaction.create({ workspaceId, customerId: keep.id, kind: 'merge', points, balanceAfter: keep.loyaltyPoints, note }, { transaction });
    if (credit) await db.StoreCreditTransaction.create({ workspaceId, customerId: keep.id, kind: 'merge', amount: credit, balanceAfter: keep.storeCreditAmount, currency: (await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'], transaction })).defaultCurrency || 'EGP', note }, { transaction });

    const gone = { id: dup.id, fullName: dup.fullName, phone: dup.phoneRaw || dup.phoneNormalized, email: dup.email };
    await dup.destroy({ transaction, hooks: false });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'customer.merge', entityType: 'Customer', entityId: keep.id, before: { duplicate: gone }, after: { moved, points, credit }, req, transaction });
    return { customer: { id: keep.id, fullName: keep.fullName, phone: keep.phoneRaw || keep.phoneNormalized, alternatePhone: keep.alternatePhone, email: keep.email }, moved, pointsAdded: points, creditAdded: String(credit) };
  });
}

/** Possible duplicates of a customer: the same email, or a phone that ends the same (last 9 digits), or the same name. */
async function candidates(workspaceId, customer) {
  const tail = String(customer.phoneNormalized || '').replace(/\D/g, '').slice(-9);
  return db.sequelize.query(
    `SELECT id, full_name AS "fullName", phone_normalized AS phone, email, total_orders AS "totalOrders", created_at AS "createdAt",
            ARRAY_REMOVE(ARRAY[
              CASE WHEN :email <> '' AND lower(email) = lower(:email) THEN 'email' END,
              CASE WHEN :tail <> '' AND right(regexp_replace(coalesce(phone_normalized, ''), '\\D', '', 'g'), 9) = :tail THEN 'phone' END,
              CASE WHEN :name <> '' AND lower(trim(full_name)) = lower(:name) THEN 'name' END], NULL) AS reasons
       FROM customers
      WHERE workspace_id = :ws AND id <> :id
        AND ((:email <> '' AND lower(email) = lower(:email))
          OR (:tail <> '' AND right(regexp_replace(coalesce(phone_normalized, ''), '\\D', '', 'g'), 9) = :tail)
          OR (:name <> '' AND lower(trim(full_name)) = lower(:name)))
      ORDER BY total_orders DESC LIMIT 20`,
    { replacements: { ws: workspaceId, id: customer.id, email: customer.email || '', tail: tail.length === 9 ? tail : '', name: (customer.fullName || '').trim() }, type: QueryTypes.SELECT }
  );
}

// Mounted at /api/v1/workspaces/:workspaceId/customer-merge (customers.manage).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.CUSTOMERS_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };

router.get('/candidates/:customerId', validate({ params: Joi.object({ ...ws, customerId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const c = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId } });
  if (!c) throw new NotFoundError('Customer');
  res.json({ candidates: await candidates(req.tenant.workspaceId, c) });
}));
router.post('/', validate({ params: Joi.object(ws), body: Joi.object({ keepId: Joi.string().uuid().required(), duplicateId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  res.json(await merge(req.tenant.workspaceId, req.body.keepId, req.body.duplicateId, req));
}));

module.exports = { router, merge, candidates };
