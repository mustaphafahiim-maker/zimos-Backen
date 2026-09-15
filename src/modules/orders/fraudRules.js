'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluates the merchant's fraud rules (workspace.settings.fraud_rules) for a
 * storefront order about to be created, inside the order transaction.
 * Returns the extra risk flags; throws ORDER_BLOCKED when the merchant chose
 * to block instead of flag. Staff-created orders never go through this.
 */
async function evaluateFraudRules({ workspaceId, customer, variantIds, transaction }) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['settings'], transaction });
  const rules = (workspace && workspace.settings && workspace.settings.fraud_rules) || null;
  const flags = [];
  if (!rules) return flags;

  if (customer.isBlacklisted && rules.block_blacklisted) {
    throw new AppError('ORDER_BLOCKED', "This order can't be placed. Please contact the store.", 422);
  }

  if (customer.id) {
    const baseWhere = { workspaceId, customerId: customer.id, cancelledAt: null };

    if (rules.duplicate_window_minutes && variantIds.length > 0) {
      const duplicate = await db.Order.findOne({
        where: { ...baseWhere, createdAt: { [Op.gte]: new Date(Date.now() - rules.duplicate_window_minutes * 60 * 1000) } },
        include: [{ model: db.OrderItem, as: 'items', where: { variantId: variantIds }, required: true, attributes: ['id'] }],
        attributes: ['id'],
        transaction,
      });
      if (duplicate) flags.push('duplicate_order');
    }

    if (rules.max_orders_per_phone_per_day) {
      const today = await db.Order.count({ where: { ...baseWhere, createdAt: { [Op.gte]: new Date(Date.now() - DAY_MS) } }, transaction });
      if (today >= rules.max_orders_per_phone_per_day) flags.push('phone_daily_limit');
    }

    if (rules.high_rejection_threshold) {
      const rejected = await db.Order.count({ where: { workspaceId, customerId: customer.id, confirmationState: 'rejected' }, transaction });
      if (rejected >= rules.high_rejection_threshold) flags.push('high_rejection_customer');
    }
  }

  if (flags.length > 0 && rules.action === 'block') {
    throw new AppError('ORDER_BLOCKED', "This order can't be placed. Please contact the store.", 422, flags.map((f) => ({ field: 'riskFlags', message: f })));
  }
  return flags;
}

module.exports = { evaluateFraudRules };
