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
 *
 * The new owner says yes (spec-gaps item 379): the owner's POST makes an
 * offer (kept in workspaces.settings.ownership_offer, 7 days, one at a time),
 * the person accepts or declines it under /me/ownership-offers, and only the
 * accept moves the store — every check above runs again at that moment.
 */

const OFFER_DAYS = 7;
const offerOf = (workspace) => {
  const o = workspace && workspace.settings && workspace.settings.ownership_offer;
  return o && o.toUserId && new Date(o.expiresAt) > new Date() ? o : null;
};
async function setOffer(workspaceId, offer, transaction) {
  await db.sequelize.query(
    offer
      ? `UPDATE workspaces SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ownership_offer}', CAST(:o AS jsonb)), updated_at = now() WHERE id = :id`
      : `UPDATE workspaces SET settings = COALESCE(settings, '{}'::jsonb) - 'ownership_offer', updated_at = now() WHERE id = :id`,
    { replacements: { o: JSON.stringify(offer || null), id: workspaceId }, transaction }
  );
}

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

/** The owner offers the store to a team member (password confirmed); nothing moves until they accept. */
async function offer(workspaceId, { newOwnerUserId, password, keepAs }, req) {
  const me = await db.User.findByPk(req.user.id, { attributes: ['id', 'email', 'fullName', 'passwordHash'] });
  if (!me.passwordHash) throw new ValidationError([{ field: 'password', message: 'Set a password on your account first' }]);
  if (!(await verifyPassword(password, me.passwordHash))) throw new ValidationError([{ field: 'password', message: 'The password is not right' }]);
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const target = await checkTransfer(workspace, me, newOwnerUserId, transaction);
    const made = { toUserId: newOwnerUserId, fromUserId: me.id, keepAs, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + OFFER_DAYS * 864e5).toISOString() };
    await setOffer(workspaceId, made, transaction);
    await recordAudit({ workspaceId, actorUserId: me.id, action: 'workspace.ownership_offer', entityType: 'Workspace', entityId: workspaceId, after: { toUserId: newOwnerUserId, keepAs, expiresAt: made.expiresAt }, req, transaction });
    transaction.afterCommit(() => {
      notify.email({ workspaceId, recipient: target.user.email, template: 'store_ownership_offered', data: { workspaceName: workspace.name, fromName: me.fullName || me.email } }).catch(() => {});
    });
    return { offer: { ...made, toUser: { userId: target.user.id, fullName: target.user.fullName, email: target.user.email } } };
  });
}

/** Everything the transfer needs, checked when it is offered and again when it is accepted. */
async function checkTransfer(workspace, me, newOwnerUserId, transaction) {
  const workspaceId = workspace.id;
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
  target.sub = sub;
  return target;
}

/** The new owner accepts: the checks run again, then the store moves (the old one-step transfer). */
async function accept(workspaceId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const pending = offerOf(workspace);
    if (!pending || pending.toUserId !== req.user.id) throw new NotFoundError('Ownership offer');
    const me = await db.User.findByPk(pending.fromUserId, { attributes: ['id', 'email', 'fullName'], transaction });
    if (!me || workspace.ownerUserId !== me.id) {
      await setOffer(workspaceId, null, transaction);
      throw new AppError('OFFER_NO_LONGER_VALID', 'This store has changed hands since the offer', 409);
    }
    const target = await checkTransfer(workspace, me, req.user.id, transaction);
    const { sub } = target;
    const newOwnerUserId = req.user.id;
    const keepAs = pending.keepAs || 'workspace_manager';

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
    await setOffer(workspaceId, null, transaction);

    await recordAudit({ workspaceId, actorUserId: newOwnerUserId, action: 'workspace.ownership_transfer', entityType: 'Workspace', entityId: workspaceId, before: { ownerUserId: me.id }, after: { ownerUserId: newOwnerUserId, previousOwnerKeptAs: keepAs, offeredBy: me.id, acceptedBy: newOwnerUserId }, req, transaction });
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

async function decline(workspaceId, req) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings', 'name', 'ownerUserId'] });
  const pending = offerOf(workspace);
  if (!pending || pending.toUserId !== req.user.id) throw new NotFoundError('Ownership offer');
  await setOffer(workspaceId, null);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'workspace.ownership_offer_declined', entityType: 'Workspace', entityId: workspaceId, before: { toUserId: pending.toUserId }, req });
  return { declined: true };
}

async function myOffers(userId) {
  const rows = await db.sequelize.query(
    `SELECT w.id, w.name, w.settings->'ownership_offer' AS offer, u.full_name AS "fromName", u.email AS "fromEmail"
       FROM workspaces w LEFT JOIN users u ON u.id = (w.settings->'ownership_offer'->>'fromUserId')::uuid
      WHERE w.settings->'ownership_offer'->>'toUserId' = :uid AND (w.settings->'ownership_offer'->>'expiresAt')::timestamptz > now()`,
    { replacements: { uid: userId }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return { offers: rows.map((r) => ({ workspaceId: r.id, workspaceName: r.name, from: { fullName: r.fromName, email: r.fromEmail }, keepAs: r.offer.keepAs, expiresAt: r.offer.expiresAt })) };
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
  res.status(201).json(await offer(req.tenant.workspaceId, req.body, req));
}));

/** The owner sees or withdraws the pending offer. */
const ownerOnly = async (req) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'ownerUserId', 'settings'] });
  if (workspace.ownerUserId !== req.user.id) throw new AppError('NOT_STORE_OWNER', 'Only the store owner can transfer it', 403);
  return workspace;
};
router.get('/', validate({ params }), asyncHandler(async (req, res) => res.json({ offer: offerOf(await ownerOnly(req)) })));
router.delete('/', validate({ params }), asyncHandler(async (req, res) => {
  await ownerOnly(req);
  await setOffer(req.tenant.workspaceId, null);
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'workspace.ownership_offer_withdrawn', entityType: 'Workspace', entityId: req.tenant.workspaceId, req });
  res.json({ withdrawn: true });
}));

// Mounted at /api/v1/me/ownership-offers — the person the store is offered to.
const me = Router();
me.use(authenticate);
const wsParam = Joi.object({ workspaceId: Joi.string().uuid().required() });
me.get('/', asyncHandler(async (req, res) => res.json(await myOffers(req.user.id))));
me.post('/:workspaceId/accept', validate({ params: wsParam }), asyncHandler(async (req, res) => res.json(await accept(req.params.workspaceId, req))));
me.post('/:workspaceId/decline', validate({ params: wsParam }), asyncHandler(async (req, res) => res.json(await decline(req.params.workspaceId, req))));

module.exports = { router, me, offer, accept, decline, candidates };
