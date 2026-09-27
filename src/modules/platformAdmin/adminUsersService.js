'use strict';

const db = require('../../db/models');
const { AppError, AuthorizationError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Who may use the platform admin console: the `users.platform_admin` flag,
 * granted to and revoked from existing accounts by email. There are no
 * invitations and no finer-grained roles — the flag is the whole model.
 *
 * `authenticate` reloads the user on every request, so a grant or a revoke
 * takes effect on that user's very next call; no token has to expire first.
 *
 * Two rules are enforced on revoke, inside one transaction that row-locks
 * every current admin:
 *
 *   - nobody revokes themselves (another admin has to), and
 *   - the last admin is never revoked.
 *
 * The lock is what makes the second rule hold under concurrency: two admins
 * revoking each other at the same moment are serialized, and the second one
 * finds a single admin left and is refused.
 */

const ADMIN_ATTRIBUTES = ['id', 'email', 'fullName', 'status', 'lastLoginAt', 'createdAt'];

function serializeAdmin(user, viewerId) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    isYou: user.id === viewerId,
  };
}

async function listAdmins(viewerId) {
  const users = await db.User.findAll({
    where: { platformAdmin: true },
    attributes: ADMIN_ATTRIBUTES,
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return users.map((u) => serializeAdmin(u, viewerId));
}

/**
 * Grants the flag to the account with this email. Idempotent: an account that
 * is already an admin comes back unchanged with `granted: false` and no audit
 * row, because nothing changed.
 */
async function grantAdmin(email, req) {
  return db.sequelize.transaction(async (transaction) => {
    // users.email is CITEXT, so this match ignores case.
    const user = await db.User.findOne({
      where: { email: email.trim() },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) {
      throw new AppError(
        'USER_NOT_FOUND',
        'No account uses that email. The person has to sign up before they can be made an admin.',
        404
      );
    }
    if (user.platformAdmin) return { admin: serializeAdmin(user, req.user.id), granted: false };
    if (user.status !== 'active') {
      throw new ConflictError(
        user.status === 'suspended'
          ? 'That account is suspended and cannot be made an admin.'
          : 'That account has not finished verifying its email yet. Try again once it is active.',
        'USER_NOT_ACTIVE'
      );
    }

    await user.update({ platformAdmin: true }, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'platform_admin.grant',
      entityType: 'User',
      entityId: user.id,
      before: { platformAdmin: false },
      after: { platformAdmin: true },
      metadata: { email: user.email },
      req,
      transaction,
    });
    return { admin: serializeAdmin(user, req.user.id), granted: true };
  });
}

async function revokeAdmin(userId, req) {
  if (userId === req.user.id) {
    throw new ConflictError('You cannot revoke your own admin access. Ask another admin to do it.', 'CANNOT_REVOKE_SELF');
  }

  return db.sequelize.transaction(async (transaction) => {
    const admins = await db.User.findAll({
      where: { platformAdmin: true },
      attributes: ['id', 'email', 'platformAdmin'],
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    const target = admins.find((u) => u.id === userId);
    if (!target) throw new NotFoundError('Platform admin');
    if (admins.length <= 1) {
      throw new ConflictError('This is the last platform admin, so their access cannot be revoked.', 'LAST_ADMIN');
    }
    // The requester's own flag, re-read under the lock: an admin revoked a
    // moment ago must not complete a revoke that was already in flight.
    if (!admins.some((u) => u.id === req.user.id)) throw new AuthorizationError('Platform admin access required');

    await target.update({ platformAdmin: false }, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'platform_admin.revoke',
      entityType: 'User',
      entityId: target.id,
      before: { platformAdmin: true },
      after: { platformAdmin: false },
      metadata: { email: target.email },
      req,
      transaction,
    });
    return { success: true };
  });
}

module.exports = { listAdmins, grantAdmin, revokeAdmin };
