'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * The invitee's side of a team invite (spec-gaps item 358). An invite is a
 * membership with status 'invited', no user and the invited email
 * (workspaceService.inviteMember); it joins nobody to a team until the
 * person accepts it here. Whoever is signed in with an account whose email
 * is the invited one, and confirmed, sees it and can accept or decline it,
 * whether the account existed when the invite was sent or was made later.
 *
 *   GET  /api/v1/me/invites                       my pending invites
 *   POST /api/v1/me/invites/:membershipId/accept  join the team with the invite's role
 *   POST /api/v1/me/invites/:membershipId/decline delete the invite
 *
 * An account whose email is not confirmed sees no invites (emailConfirmed
 * false) and gets 409 EMAIL_NOT_CONFIRMED on accept: anyone can sign up with
 * an address they don't own (item 330). An invite for another email, or one
 * already used, is 404, the same as a missing one.
 */

const myEmail = (user) => String(user.email || '').trim().toLowerCase();
const invitedTo = (email) => db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('Membership.invited_email')), email);

const shape = (m) => ({
  id: m.id,
  workspace: m.workspace ? { id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug } : null,
  role: m.role ? { id: m.role.id, key: m.role.key, name: m.role.name } : null,
  invitedAt: m.createdAt,
});

async function listMine(user) {
  if (!user.emailVerifiedAt) return { emailConfirmed: false, invites: [] };
  const rows = await db.Membership.findAll({
    where: { status: 'invited', userId: null, [Op.and]: [invitedTo(myEmail(user))] },
    include: [
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug', 'status'], where: { status: { [Op.ne]: 'closed' } } },
      { model: db.Role, as: 'role', attributes: ['id', 'key', 'name'] },
    ],
    order: [['createdAt', 'ASC']],
  });
  return { emailConfirmed: true, invites: rows.map(shape) };
}

/** The invite, locked, when it is pending and addressed to this account's email. */
async function findMine(user, membershipId, transaction) {
  const invite = await db.Membership.findOne({
    where: { id: membershipId, status: 'invited', userId: null, [Op.and]: [invitedTo(myEmail(user))] },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!invite) throw new NotFoundError('Invite');
  return invite;
}

async function accept(user, membershipId, req) {
  if (!user.emailVerifiedAt) {
    throw new AppError('EMAIL_NOT_CONFIRMED', 'Confirm your email address first, then accept the invite', 409);
  }
  // Already on that team: the invite is deleted and committed, then 409
  // (throwing inside the transaction would roll the delete back).
  const result = await db.sequelize.transaction(async (transaction) => {
    const invite = await findMine(user, membershipId, transaction);
    const workspace = await db.Workspace.findByPk(invite.workspaceId, { attributes: ['id', 'name', 'slug', 'status'], transaction });
    if (!workspace || workspace.status === 'closed') throw new NotFoundError('Invite');
    const existing = await db.Membership.findOne({ where: { workspaceId: invite.workspaceId, userId: user.id }, transaction });
    if (existing) {
      await invite.destroy({ transaction });
      return null;
    }
    const email = invite.invitedEmail;
    await invite.update({ userId: user.id, status: 'active', invitedEmail: null }, { transaction });
    const role = await db.Role.findByPk(invite.roleId, { attributes: ['id', 'key', 'name'], transaction });
    await recordAudit({
      workspaceId: invite.workspaceId,
      actorUserId: user.id,
      action: 'membership.invite_accept',
      entityType: 'Membership',
      entityId: invite.id,
      after: { email, userId: user.id, roleId: invite.roleId },
      req,
      transaction,
    });
    return {
      membership: { id: invite.id, status: 'active' },
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      role: role ? { id: role.id, key: role.key, name: role.name } : null,
    };
  });
  if (!result) throw new ConflictError('You are already on this team', 'ALREADY_MEMBER');
  return result;
}

async function decline(user, membershipId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const invite = await findMine(user, membershipId, transaction);
    const email = invite.invitedEmail;
    await invite.destroy({ transaction });
    await recordAudit({
      workspaceId: invite.workspaceId,
      actorUserId: user.id,
      action: 'membership.invite_decline',
      entityType: 'Membership',
      entityId: invite.id,
      after: { email },
      req,
      transaction,
    });
    return { declined: true };
  });
}

const router = Router();
router.use(authenticate);
const params = Joi.object({ membershipId: Joi.string().uuid().required() });

router.get('/', asyncHandler(async (req, res) => {
  res.json(await listMine(req.user));
}));
router.post('/:membershipId/accept', validate({ params }), asyncHandler(async (req, res) => {
  res.json(await accept(req.user, req.params.membershipId, req));
}));
router.post('/:membershipId/decline', validate({ params }), asyncHandler(async (req, res) => {
  res.json(await decline(req.user, req.params.membershipId, req));
}));

module.exports = { router, listMine, accept, decline };
