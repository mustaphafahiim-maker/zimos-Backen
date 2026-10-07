'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Pay later on account — net terms (spec-gaps item 229).
 *
 * The store approves a business customer for it: customers.on_account_enabled,
 * credit_limit (most they may owe at once, minor units; null = no limit) and
 * payment_terms_days. Such a customer, signed in (X-Shopper-Token, order under
 * their own phone), may check out with paymentMethod 'on_account': the order
 * ships like cash on delivery but nothing is collected at the door, and is
 * due payment_terms_days later (orders.payment_due_at). The team can also
 * enter such an order for them.
 *
 * Owed = what is unpaid on their on-account orders that are not cancelled.
 * An order that would take them over the limit is refused (422
 * CREDIT_LIMIT_EXCEEDED) before it is created. The team records payments
 * as they arrive (a captured `manual` payment, method on_account); overdue
 * orders are listed and summed.
 */

const ON_ACCOUNT_SHOPPER = Symbol.for('zimos.onAccountCustomer');
const DAY_MS = 86400000;

/** Checkout: the signed-in shopper approved for it, or a clear refusal. */
async function markCheckout(workspaceId, shopperToken, orderBody) {
  const shopper = shopperToken ? await require('../shopperAccounts/shopperAuth').readToken(workspaceId, shopperToken) : null;
  if (!shopper) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in to pay later on account', 401);
  if (!shopper.onAccountEnabled) throw new ValidationError([{ field: 'paymentMethod', message: 'Paying later on account is not open for this account' }], 'Invalid body');
  orderBody[ON_ACCOUNT_SHOPPER] = shopper.id;
}

async function owedBy(customerId, transaction = null) {
  const [row] = await db.sequelize.query(
    `SELECT COALESCE(SUM(GREATEST(total_amount - amount_paid, 0)), 0)::bigint AS owed
       FROM orders WHERE customer_id = :c AND payment_method = 'on_account' AND cancelled_at IS NULL AND is_test = false`,
    { replacements: { c: customerId }, type: QueryTypes.SELECT, transaction }
  );
  return Number(row.owed);
}

/**
 * orderService, before the order row: an on-account order needs an approved
 * customer (the signed-in shopper, or the team ordering for them) and room
 * under the limit. Returns { paymentDueAt } or null for other methods.
 */
async function checkOrder(customer, paymentMethod, totalAmount, payload, req, transaction) {
  if (paymentMethod !== 'on_account') return null;
  const byStaff = Boolean(req && req.user && req.user.id);
  if (!byStaff && (!payload || payload[ON_ACCOUNT_SHOPPER] !== customer.id)) {
    throw new ValidationError([{ field: 'paymentMethod', message: 'Paying later on account needs the approved customer signed in, ordering under their own phone' }], 'Invalid body');
  }
  // Lock the customer: two orders at once cannot both slip under the limit.
  const locked = await db.Customer.findByPk(customer.id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!locked.onAccountEnabled) throw new ValidationError([{ field: 'paymentMethod', message: 'Paying later on account is not open for this customer' }], 'Invalid body');
  if (locked.creditLimit != null) {
    const owed = await owedBy(locked.id, transaction);
    if (owed + Number(totalAmount) > Number(locked.creditLimit)) {
      throw new AppError('CREDIT_LIMIT_EXCEEDED', 'This order is more than the credit left on the account', 422, { creditLimit: String(locked.creditLimit), owed: String(owed), available: String(Math.max(0, Number(locked.creditLimit) - owed)) });
    }
  }
  return { paymentDueAt: new Date(Date.now() + (locked.paymentTermsDays || 0) * DAY_MS) };
}

async function statementOf(customer) {
  const orders = await db.Order.findAll({
    where: { customerId: customer.id, paymentMethod: 'on_account', cancelledAt: null, isTest: false },
    attributes: ['id', 'orderNumber', 'totalAmount', 'amountPaid', 'currency', 'financialState', 'paymentDueAt', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit: 200,
  });
  const now = new Date();
  const open = orders.filter((o) => Number(o.totalAmount) > Number(o.amountPaid));
  const owed = open.reduce((n, o) => n + Number(o.totalAmount) - Number(o.amountPaid), 0);
  const overdue = open.filter((o) => o.paymentDueAt && o.paymentDueAt < now).reduce((n, o) => n + Number(o.totalAmount) - Number(o.amountPaid), 0);
  return {
    enabled: customer.onAccountEnabled,
    creditLimit: customer.creditLimit == null ? null : String(customer.creditLimit),
    paymentTermsDays: customer.paymentTermsDays,
    owed: String(owed),
    overdue: String(overdue),
    available: customer.creditLimit == null ? null : String(Math.max(0, Number(customer.creditLimit) - owed)),
    orders: orders.map((o) => ({ id: o.id, orderNumber: o.orderNumber, totalAmount: String(o.totalAmount), amountPaid: String(o.amountPaid), due: String(Math.max(0, Number(o.totalAmount) - Number(o.amountPaid))), currency: o.currency, financialState: o.financialState, paymentDueAt: o.paymentDueAt, overdue: Boolean(o.paymentDueAt && o.paymentDueAt < now && Number(o.totalAmount) > Number(o.amountPaid)), createdAt: o.createdAt })),
  };
}

// ----------------------------------------------------------------- staff --

// Mounted at /api/v1/workspaces/:workspaceId/account-credit.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const custP = Joi.object({ ...ws, customerId: Joi.string().uuid().required() });

async function customerOf(req) {
  const c = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId } });
  if (!c) throw new NotFoundError('Customer');
  return c;
}

staff.get('/customers/:customerId', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: custP }), asyncHandler(async (req, res) => res.json(await statementOf(await customerOf(req)))));
staff.put(
  '/customers/:customerId',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ params: custP, body: Joi.object({ enabled: Joi.boolean().required(), creditLimit: Joi.number().integer().min(0).max(1e13).allow(null).default(null), paymentTermsDays: Joi.number().integer().min(0).max(365).default(30) }) }),
  asyncHandler(async (req, res) => {
    const c = await customerOf(req);
    const before = { enabled: c.onAccountEnabled, creditLimit: c.creditLimit, paymentTermsDays: c.paymentTermsDays };
    await c.update({ onAccountEnabled: req.body.enabled, creditLimit: req.body.creditLimit, paymentTermsDays: req.body.paymentTermsDays });
    await recordAudit({ workspaceId: c.workspaceId, actorUserId: req.user.id, action: 'customer.on_account_update', entityType: 'Customer', entityId: c.id, before, after: req.body, req });
    res.json(await statementOf(c));
  })
);
// Every approved customer with what they owe; ?overdue=true for those late.
staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ overdue: Joi.boolean() }) }), asyncHandler(async (req, res) => {
  const rows = await db.sequelize.query(
    `SELECT c.id, c.full_name AS "fullName", c.company_name AS "companyName", c.credit_limit AS "creditLimit", c.payment_terms_days AS "paymentTermsDays",
            COALESCE(SUM(GREATEST(o.total_amount - o.amount_paid, 0)), 0)::bigint AS owed,
            COALESCE(SUM(CASE WHEN o.payment_due_at < now() THEN GREATEST(o.total_amount - o.amount_paid, 0) ELSE 0 END), 0)::bigint AS overdue,
            MIN(CASE WHEN o.total_amount > o.amount_paid THEN o.payment_due_at END) AS "nextDueAt"
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id AND o.payment_method = 'on_account' AND o.cancelled_at IS NULL AND o.is_test = false
      WHERE c.workspace_id = :ws AND (c.on_account_enabled = true OR o.id IS NOT NULL)
      GROUP BY c.id ORDER BY overdue DESC, owed DESC LIMIT 500`,
    { replacements: { ws: req.tenant.workspaceId }, type: QueryTypes.SELECT }
  );
  const list = rows.map((r) => ({ ...r, creditLimit: r.creditLimit == null ? null : String(r.creditLimit), owed: String(r.owed), overdue: String(r.overdue) }));
  res.json({ customers: req.query.overdue ? list.filter((r) => Number(r.overdue) > 0) : list });
}));
// A payment arrived for an on-account order (bank transfer, cheque…).
staff.post(
  '/orders/:orderId/payments',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: Joi.object({ ...ws, orderId: Joi.string().uuid().required() }), body: Joi.object({ amount: Joi.number().integer().min(1).max(1e13).required(), reference: Joi.string().trim().max(120).allow('', null), paidAt: Joi.date().iso().max('now').allow(null) }) }),
  asyncHandler(async (req, res) => {
    const out = await db.sequelize.transaction(async (transaction) => {
      const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId: req.tenant.workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!order) throw new NotFoundError('Order');
      if (order.paymentMethod !== 'on_account') throw new AppError('NOT_ON_ACCOUNT', 'This order is not paid on account', 409);
      if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'The order is cancelled', 409);
      const due = Number(order.totalAmount) - Number(order.amountPaid);
      if (req.body.amount > due) throw new ValidationError([{ field: 'amount', message: `At most ${due} is due` }]);
      const payment = await db.Payment.create({
        workspaceId: order.workspaceId, orderId: order.id, providerCode: 'manual', method: 'on_account', status: 'captured',
        amount: req.body.amount, currency: order.currency, providerReference: req.body.reference || null, maskedDisplay: 'On account', paidAt: req.body.paidAt || new Date(),
      }, { transaction });
      const amountPaid = Number(order.amountPaid) + req.body.amount;
      await order.update({ amountPaid }, { transaction });
      await require('../orders/orderStateService').setFinancialState(order.workspaceId, order.id, amountPaid >= Number(order.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
      return { paymentId: payment.id, amountPaid: String(amountPaid), due: String(Number(order.totalAmount) - amountPaid) };
    });
    await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'order.on_account_payment', entityType: 'Order', entityId: req.params.orderId, after: { amount: req.body.amount, reference: req.body.reference || null }, req });
    res.status(201).json(out);
  })
);

// Mounted at /api/v1/store/:workspaceId/account/on-account — the signed-in shopper's statement.
const account = Router({ mergeParams: true });
account.get('/', resolvePublicWorkspace, asyncHandler(async (req, res) => {
  const c = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!c) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  res.set('Cache-Control', 'private, no-store');
  if (!c.onAccountEnabled && !(await db.Order.count({ where: { customerId: c.id, paymentMethod: 'on_account' } }))) return res.json({ enabled: false });
  return res.json(await statementOf(c));
}));

module.exports = { staff, account, markCheckout, checkOrder, owedBy, statementOf, ON_ACCOUNT_SHOPPER };
