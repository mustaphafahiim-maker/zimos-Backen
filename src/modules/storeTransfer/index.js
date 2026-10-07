'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { verifyPassword } = require('../../core/security/password');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const entitlements = require('../billing/entitlementsService');
const notify = require('../notifications/notify');
const { isVerified } = require('../auth/signupPolicy');

/*
 * Transfer a store to another owner (spec-gaps item 252). Only the store's
 * owner (workspaces.owner_user_id — the account whose plan limits the store
 * counts against) can do it, with their password, to an active member of the
 * store's team. In one transaction:
 *   - the store's owner becomes the new person, whose team role becomes Owner;
 *   - the old owner stays as Store manager (default), stays an Owner, or
 *     leaves the team (`keepAs`);
 *   - the store must fit the new owner's plan limits (their own stores plus
 *     this one), else 409 PLAN_LIMIT_REACHED.
 * The new owner's account must be confirmed (email or phone, spec-gaps item
 * 330): one that isn't is left out of the candidates and refused with 409
 * NEW_OWNER_NOT_CONFIRMED.
 * The store's plan and subscription stay with the store. Both people get an
 * email; it is audited. There is no undo other than the new owner handing
 * it back.
 */

const KEEP_AS = ['workspace_manager', 'owner', 'leave'];

async function candidates(workspace) {
  const rows = await db.Membership.findAll({
    where: { workspaceId: workspace.id, status: 'active' },
    include: [
      { model: db.User, as: 'user', attributes: ['id', 'fullName', 'email', 'status', 'emailVerifiedAt', 'phoneVerifiedAt'] },
      { model: db.Role, as: 'role', attributes: ['key', 'name'] },
    ],
    order: [['createdAt', 'ASC']],
  });
  return rows
    .filter((m) => m.user && m.user.id !== workspace.ownerUserId && m.user.status === 'active' && isVerified(m.user))
    .map((m) => ({ userId: m.user.id, fullName: m.user.fullName, email: m.user.email, role: m.role ? { key: m.role.key, name: m.role.name } : null }));
}

async function transfer(workspaceId, { newOwnerUserId, password, keepAs }, req) {
  const me = await db.User.findByPk(req.user.id, { attributes: ['id', 'email', 'fullName', 'passwordHash'] });
  if (!me.passwordHash) throw new ValidationError([{ field: 'password', message: 'Set a password on your account first' }]);
  if (!(await verifyPassword(password, me.passwordHash))) throw new ValidationError([{ field: 'password', message: 'The password is not right' }]);

  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (workspace.ownerUserId !== me.id) throw new AppError('NOT_STORE_OWNER', 'Only the store owner can transfer it', 403);
    if (newOwnerUserId === me.id) throw new ValidationError([{ field: 'newOwnerUserId', message: 'Pick someone else' }]);

    const target = await db.Membership.findOne({ where: { workspaceId, userId: newOwnerUserId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (target) target.user = await db.User.findByPk(newOwnerUserId, { attributes: ['id', 'email', 'fullName', 'status', 'emailVerifiedAt', 'phoneVerifiedAt'], transaction });
    if (!target || !target.user || target.user.status !== 'active') throw new NotFoundError('Team member');
    if (!isVerified(target.user)) {
      throw new AppError('NEW_OWNER_NOT_CONFIRMED', "That person's account hasn't confirmed its email yet. Ask them to confirm it first.", 409);
    }

    // The store has to fit the new owner's plan limits.
    const sub = await db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'name', 'maxStores'] }], transaction });
    const allowance = await entitlements.storeAllowance(newOwnerUserId, sub && sub.plan, { transaction });
    if (allowance.max !== null && allowance.used >= allowance.max) {
      throw new AppError('PLAN_LIMIT_REACHED', `${target.user.fullName || target.user.email} already has as many stores as their plan allows`, 409, { limit: 'stores', max: allowance.max, used: allowance.used });
    }

    const roles = await db.Role.findAll({ where: { workspaceId, key: ['owner', 'workspace_manager'] }, transaction });
    const ownerRole = roles.find((r) => r.key === 'owner');
    const managerRole = roles.find((r) => r.key === 'workspace_manager');
    await target.update({ roleId: ownerRole.id }, { transaction });
    const mine = await db.Membership.findOne({ where: { workspaceId, userId: me.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (mine) {
      if (keepAs === 'leave') await mine.destroy({ transaction });
      else await mine.update({ roleId: keepAs === 'owner' ? ownerRole.id : managerRole.id }, { transaction });
    }
    await workspace.update({ ownerUserId: newOwnerUserId }, { transaction });

    await recordAudit({ workspaceId, actorUserId: me.id, action: 'workspace.ownership_transfer', entityType: 'Workspace', entityId: workspaceId, before: { ownerUserId: me.id }, after: { ownerUserId: newOwnerUserId, previousOwnerKeptAs: keepAs }, req, transaction });
    transaction.afterCommit(() => {
      const data = { workspaceName: workspace.name, fromName: me.fullName || me.email, toName: target.user.fullName || target.user.email };
      notify.email({ workspaceId, recipient: target.user.email, template: 'store_ownership_received', data }).catch(() => {});
      notify.email({ workspaceId, recipient: me.email, template: 'store_ownership_given', data }).catch(() => {});
    });
    return {
      workspace: { id: workspace.id, name: workspace.name, ownerUserId: newOwnerUserId },
      newOwner: { userId: target.user.id, fullName: target.user.fullName, email: target.user.email },
      previousOwner: { userId: me.id, keptAs: keepAs },
      billing: { plan: sub && sub.plan ? sub.plan.name : null, external: Boolean(sub && sub.externalSubscriptionId) },
    };
  });
}

// Mounted at /api/v1/workspaces/:workspaceId/ownership-transfer — the owner only (checked in the service).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });

router.get('/candidates', validate({ params }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'ownerUserId'] });
  if (workspace.ownerUserId !== req.user.id) throw new AppError('NOT_STORE_OWNER', 'Only the store owner can transfer it', 403);
  res.json({ candidates: await candidates(workspace) });
}));

router.post('/', validate({
  params,
  body: Joi.object({
    newOwnerUserId: Joi.string().uuid().required(),
    password: Joi.string().min(1).max(200).required(),
    keepAs: Joi.string().valid(...KEEP_AS).default('workspace_manager'),
  }),
}), asyncHandler(async (req, res) => {
  res.json(await transfer(req.tenant.workspaceId, req.body, req));
}));

module.exports = { router, transfer, candidates };
