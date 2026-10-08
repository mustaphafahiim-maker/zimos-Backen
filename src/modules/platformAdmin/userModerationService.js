'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, AuthorizationError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES, PLATFORM_PERMISSIONS, hasPlatformPermission } = require('../../core/security/platformPermissions');
const { isVerified } = require('../auth/signupPolicy');

/**
 * Suspending and deleting an account from the console (workspaces.manage).
 * Ziad's 26df946 (spec-gaps item 337), adapted to ours.
 *
 *   - suspend: status 'suspended' with when and why, every session revoked
 *     (and with it every access token: they name their session,
 *     core/security/sessionGate), sign-ins waiting for a second step closed.
 *     Every way in answers no: password (ACCOUNT_SUSPENDED), Google
 *     (ACCOUNT_SUSPENDED, nothing linked), the WhatsApp code, the sign-up
 *     code's token, refresh, authenticate, the account's API keys and the
 *     partner-app tokens it approved (they act as it: apiKeys/apiKeyAuth),
 *     and a partner app's code it approved is not swapped for a token.
 *   - unsuspend: back to the status it had (active; or pending_verification
 *     for an account that had not confirmed its email when it was suspended
 *     and still has not, so our default sign-up's emailed link still stands
 *     between it and the dashboard). A deleted account stays deleted.
 *   - delete: soft. The row stays so stores, orders and audit rows keep their
 *     foreign keys; email, phone, name, username and picture are anonymised,
 *     the password removed, sessions revoked, status 'suspended' and
 *     deleted_at set. Every way back in that is still out is closed too:
 *     reset / confirmation links, account codes, email changes, sign-ins
 *     waiting for a second step, remembered browsers, two-step sign-in (its
 *     secrets wiped), push devices and partner-app codes not swapped yet. The
 *     Google id is kept so that Google account is refused (ACCOUNT_DELETED)
 *     instead of silently getting a new account. An account that owns stores
 *     is deleted only with `stores: 'suspend'`, and those stores are
 *     suspended in the same transaction. Its memberships of other stores stay
 *     (the team page shows "Deleted user"; an owner removes it as any member).
 *
 * Nobody acts on themselves; a creator's account needs a creator, another
 * console account needs admins.manage; the last creator is never suspended
 * or deleted. Every write is audited as a platform-level entry.
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

/**
 * Locks every creator plus the target and the acting admin, in id order (the
 * same rows and order as adminUsersService's lockForRoleChange), and checks
 * the actor under that lock: two admins acting on each other at the same
 * moment are serialized, and the second finds itself suspended and stops.
 * A console account (any platform role) also needs admins.manage, as changing
 * or revoking its access does.
 *
 * `permission` is what the actor needs for the action itself: workspaces.manage
 * here; support.manage for the console's two-step reset (auth/twoFactorRecovery),
 * which shares these target rules.
 */
async function lockTarget(rawUserId, req, transaction, { permission = PLATFORM_PERMISSIONS.WORKSPACES_MANAGE } = {}) {
  // Postgres matches a uuid in any case; compare the canonical form.
  const userId = String(rawUserId).toLowerCase();
  if (userId === req.user.id) {
    throw new ConflictError('You cannot do this to your own account.', 'CANNOT_ACT_ON_SELF');
  }
  const rows = await db.User.findAll({
    where: { [Op.or]: [{ platformRole: PLATFORM_ROLES.CREATOR }, { id: [userId, req.user.id] }] },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const actor = rows.find((u) => u.id === req.user.id);
  if (!actor || actor.status !== 'active' || actor.deletedAt || !hasPlatformPermission(actor, permission)) {
    throw new AuthorizationError();
  }
  const target = rows.find((u) => u.id === userId);
  if (!target) throw new NotFoundError('User');
  if (target.platformRole === PLATFORM_ROLES.CREATOR) {
    if (actor.platformRole !== PLATFORM_ROLES.CREATOR) {
      throw new AppError('CREATOR_REQUIRED', "Only a creator can act on a creator's account.", 403);
    }
    const others = rows.filter((u) => u.platformRole === PLATFORM_ROLES.CREATOR && u.status === 'active' && u.id !== target.id);
    if (others.length < 1) throw new ConflictError('This is the last creator.', 'LAST_CREATOR');
  } else if (target.platformRole && !hasPlatformPermission(actor, PLATFORM_PERMISSIONS.ADMINS_MANAGE)) {
    throw new AppError('ADMINS_MANAGE_REQUIRED', "Only an admin who manages platform users can act on a console account.", 403);
  }
  return target;
}

/** Sessions (and their access tokens) end; a sign-in that passed the password and waits for its code ends too. */
async function endSignIns(userId, now, transaction) {
  const [sessionsRevoked] = await db.Session.update({ revokedAt: now }, { where: { userId, revokedAt: null }, transaction });
  const [challengesClosed] = await db.LoginChallenge.update({ consumedAt: now }, { where: { userId, consumedAt: null }, transaction });
  return { sessionsRevoked, challengesClosed };
}

/** Everything a deleted account could still use to get back in, or that still names the person. */
async function closeEverything(userId, now, transaction) {
  const where = (extra) => ({ where: { userId, ...extra }, transaction });
  const [linksClosed] = await db.VerificationToken.update({ usedAt: now }, where({ usedAt: null }));
  const [codesClosed] = await db.VerificationCode.update({ supersededAt: now }, where({ consumedAt: null, supersededAt: null }));
  const [emailChangesClosed] = await db.EmailChange.update({ usedAt: now }, where({ usedAt: null }));
  const devicesForgotten = await db.TrustedDevice.destroy(where({}));
  // Turned off, and a secret still being set up wiped too.
  const twoFactorReset = await db.UserTwoFactor.count(where({ mode: { [Op.ne]: 'off' } }));
  await db.UserTwoFactor.update(
    { mode: 'off', totpSecretSealed: null, pendingSecretSealed: null, enabledAt: null, backupCodes: [], backupCodesCreatedAt: null },
    where({})
  );
  const pushDevicesRemoved = await db.DeviceToken.destroy(where({}));
  const [appCodesClosed] = await db.OAuthCode.update({ usedAt: now }, where({ usedAt: null }));
  return {
    linksClosed,
    codesClosed,
    emailChangesClosed,
    devicesForgotten,
    twoFactorReset: twoFactorReset > 0,
    pushDevicesRemoved,
    appCodesClosed,
  };
}

async function suspend(userId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was deleted.', 'USER_DELETED');
    if (user.status === 'suspended') throw new ConflictError('This account is already suspended.', 'USER_ALREADY_SUSPENDED');
    const before = user.status;
    const now = new Date();
    await user.update({ status: 'suspended', suspendedAt: now, suspendedReason: reason }, { transaction });
    const closed = await endSignIns(user.id, now, transaction);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.suspend',
      entityType: 'User',
      entityId: user.id,
      before: { status: before },
      after: { status: 'suspended' },
      metadata: { reason, ...closed },
      req,
      transaction,
    });
    return view(user);
  });
}

/**
 * The status to go back to: the one the console's suspension recorded, when
 * it was pending_verification and the account has still not confirmed an
 * address; otherwise active (Ziad's rule).
 */
async function statusBeforeSuspension(user, transaction) {
  if (isVerified(user)) return 'active';
  const row = await db.AuditLog.findOne({
    where: { action: 'user.suspend', entityType: 'User', entityId: user.id },
    order: [['createdAt', 'DESC']],
    attributes: ['beforeState'],
    transaction,
  });
  const was = row && row.beforeState ? row.beforeState.status : null;
  return was === 'pending_verification' ? 'pending_verification' : 'active';
}

async function unsuspend(userId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was deleted.', 'USER_DELETED');
    if (user.status !== 'suspended') throw new ConflictError('This account is not suspended.', 'USER_NOT_SUSPENDED');
    const suspendedFor = user.suspendedReason;
    const status = await statusBeforeSuspension(user, transaction);
    await user.update({ status, suspendedAt: null, suspendedReason: null }, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.unsuspend',
      entityType: 'User',
      entityId: user.id,
      before: { status: 'suspended' },
      after: { status },
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
        avatarUrl: null,
        passwordHash: null,
        phoneVerifiedAt: null,
        status: 'suspended',
        suspendedAt: user.suspendedAt || now,
        suspendedReason: reason || user.suspendedReason || null,
        deletedAt: now,
      },
      { transaction }
    );
    const closed = await endSignIns(user.id, now, transaction);
    const cleared = await closeEverything(user.id, now, transaction);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.delete',
      entityType: 'User',
      entityId: user.id,
      before: { status: before },
      after: { status: 'suspended', deleted: true },
      metadata: { reason: reason || null, ...closed, ...cleared, suspendedStores },
      req,
      transaction,
    });
    return { ...view(user), suspendedStores };
  });
}

module.exports = { suspend, unsuspend, remove, lockTarget };
