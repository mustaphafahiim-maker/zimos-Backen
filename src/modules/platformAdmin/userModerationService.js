'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES } = require('../../core/security/platformPermissions');

/**
 * Suspending and deleting an account from the console (workspaces.manage).
 *
 *   - suspend: status 'suspended' with when and why, every session revoked.
 *     Sign-in (password and Google) answers ACCOUNT_SUSPENDED; a token
 *     already issued is refused by authenticate (status not active).
 *   - unsuspend: back to 'active'. A deleted account stays deleted.
 *   - delete: soft. The row stays so stores, orders and audit rows keep their
 *     foreign keys; email, phone, name and username are anonymised, the
 *     password removed, sessions revoked, status 'suspended' and deleted_at
 *     set. The Google id is kept so that Google account is refused
 *     (ACCOUNT_DELETED) instead of silently getting a new account. An
 *     account that owns stores is deleted only with `stores: 'suspend'`, and
 *     those stores are suspended in the same transaction.
 *
 * Nobody acts on themselves; a creator's account needs a creator; the last
 * creator is never suspended or deleted. Every write is audited as a
 * platform-level entry.
 */

function view(user) {
  return {
    id: user.id,
    status: user.status,
    suspendedAt: user.suspendedAt,
    suspendedReason: user.suspendedReason,
    deletedAt: user.deletedAt,
  };
}

async function lockTarget(userId, req, transaction) {
  if (userId === req.user.id) {
    throw new ConflictError('You cannot do this to your own account.', 'CANNOT_ACT_ON_SELF');
  }
  const target = await db.User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!target) throw new NotFoundError('User');
  if (target.platformRole === PLATFORM_ROLES.CREATOR) {
    if (req.user.platformRole !== PLATFORM_ROLES.CREATOR) {
      throw new AppError('CREATOR_REQUIRED', "Only a creator can act on a creator's account.", 403);
    }
    const creators = await db.User.count({
      where: { platformRole: PLATFORM_ROLES.CREATOR, status: 'active', id: { [Op.ne]: target.id } },
      transaction,
    });
    if (creators < 1) throw new ConflictError('This is the last creator.', 'LAST_CREATOR');
  }
  return target;
}

async function revokeSessions(userId, transaction) {
  const [revoked] = await db.Session.update({ revokedAt: new Date() }, { where: { userId, revokedAt: null }, transaction });
  return revoked;
}

async function suspend(userId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was deleted.', 'USER_DELETED');
    if (user.status === 'suspended') throw new ConflictError('This account is already suspended.', 'USER_ALREADY_SUSPENDED');
    const before = user.status;
    await user.update({ status: 'suspended', suspendedAt: new Date(), suspendedReason: reason }, { transaction });
    const sessionsRevoked = await revokeSessions(user.id, transaction);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.suspend',
      entityType: 'User',
      entityId: user.id,
      before: { status: before },
      after: { status: 'suspended' },
      metadata: { reason, sessionsRevoked },
      req,
      transaction,
    });
    return view(user);
  });
}

async function unsuspend(userId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was deleted.', 'USER_DELETED');
    if (user.status !== 'suspended') throw new ConflictError('This account is not suspended.', 'USER_NOT_SUSPENDED');
    const suspendedFor = user.suspendedReason;
    await user.update({ status: 'active', suspendedAt: null, suspendedReason: null }, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.unsuspend',
      entityType: 'User',
      entityId: user.id,
      before: { status: 'suspended' },
      after: { status: 'active' },
      metadata: { reason: reason || null, suspensionReason: suspendedFor },
      req,
      transaction,
    });
    return view(user);
  });
}

async function remove(userId, { reason, stores }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was already deleted.', 'USER_DELETED');

    const owned = await db.Workspace.findAll({
      where: { ownerUserId: user.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (owned.length > 0 && stores !== 'suspend') {
      throw new AppError('OWNS_STORES', 'This account owns stores. Choose to suspend them to delete it.', 409, [
        { field: 'stores', message: `Owns ${owned.length} store(s)` },
      ]);
    }
    const now = new Date();
    const suspendedStores = [];
    for (const workspace of owned) {
      if (workspace.status !== 'active') continue;
      await workspace.update(
        { status: 'suspended', suspendedAt: now, suspendedByUserId: req.user.id, suspensionReason: reason || 'Owner account deleted' },
        { transaction }
      );
      suspendedStores.push(workspace.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'workspace.suspend',
        entityType: 'Workspace',
        entityId: workspace.id,
        before: { status: 'active' },
        after: { status: 'suspended' },
        metadata: { workspaceId: workspace.id, reason: reason || 'Owner account deleted', ownerDeleted: user.id },
        req,
        transaction,
      });
    }

    const before = user.status;
    await user.update(
      {
        email: `deleted+${user.id}@deleted.invalid`,
        phone: null,
        fullName: 'Deleted user',
        username: null,
        passwordHash: null,
        phoneVerifiedAt: null,
        status: 'suspended',
        suspendedAt: user.suspendedAt || now,
        suspendedReason: reason || user.suspendedReason || null,
        deletedAt: now,
      },
      { transaction }
    );
    const sessionsRevoked = await revokeSessions(user.id, transaction);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.delete',
      entityType: 'User',
      entityId: user.id,
      before: { status: before },
      after: { status: 'suspended', deleted: true },
      metadata: { reason: reason || null, sessionsRevoked, suspendedStores },
      req,
      transaction,
    });
    return { ...view(user), suspendedStores };
  });
}

module.exports = { suspend, unsuspend, remove };
