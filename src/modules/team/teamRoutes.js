'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS, ALL_PERMISSIONS, ACCESS_SECTIONS } = require('../../core/security/permissions');
const { ValidationError } = require('../../core/errors/AppError');
const joiEmail = require('../../core/utils/joiEmail');
const workspaceService = require('../workspaces/workspaceService');
const { requirePlanLimit } = require('../billing/planLimits');

/**
 * The simple way to add a teammate (SPEC §17.1): "Admin", or "Partial" with
 * a tick per section of the dashboard. Behind it are the same roles and
 * permissions as before — a partial invite finds or makes a custom role with
 * exactly the permissions the ticks stand for, then invites through the
 * existing workspaceService.inviteMember.
 *
 * Mounted at /api/v1/workspaces/:workspaceId/team (users.manage).
 */

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.USERS_MANAGE));

const ws = { workspaceId: Joi.string().uuid().required() };
const SECTION_KEYS = ACCESS_SECTIONS.map((s) => s.key);
// A teammate is never handed these through a section tick.
const OWNER_ONLY = [PERMISSIONS.BILLING_MANAGE, PERMISSIONS.CUSTOMERS_REVEAL_SENSITIVE];

router.get(
  '/access-options',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const [members, invited] = await Promise.all([
      db.Membership.count({ where: { workspaceId, status: 'active' } }),
      db.Membership.count({ where: { workspaceId, status: 'invited' } }),
    ]);
    // eslint-disable-next-line global-require
    const limit = await require('../billing/planLimits').limitFor(workspaceId, 'members').catch(() => null);
    res.json({
      sections: ACCESS_SECTIONS,
      permissions: ALL_PERMISSIONS,
      ownerOnly: OWNER_ONLY,
      seats: { used: members + invited, members, invited, limit },
    });
  })
);

/** The custom role holding exactly these permissions, made on first use. */
async function roleFor(workspaceId, permissions, sections) {
  const sorted = [...new Set(permissions)].sort();
  const key = `custom_${crypto.createHash('sha1').update(sorted.join(',')).digest('hex').slice(0, 16)}`;
  const label = sections.length > 0 ? sections.map((s) => s[0].toUpperCase() + s.slice(1)).join(' + ') : 'Custom access';
  const [role] = await db.Role.findOrCreate({
    where: { workspaceId, key },
    defaults: { workspaceId, key, name: label.slice(0, 100), isSystem: false, permissions: sorted },
  });
  return role;
}

router.post(
  '/invite',
  // The plan's team size, when it sets one (billing/planLimits.js).
  requirePlanLimit('members'),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      email: joiEmail().required(),
      access: Joi.string().valid('admin', 'partial').required(),
      sections: Joi.array().items(Joi.string().valid(...SECTION_KEYS)).unique().default([]),
      // The "Advanced" view: permissions ticked one by one, on top of the sections.
      permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).unique().default([]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const { email, access, sections, permissions } = req.body;
    let role;
    if (access === 'admin') {
      role = await db.Role.findOne({ where: { workspaceId, key: 'workspace_manager' } });
    } else {
      const wanted = [...sections.flatMap((key) => ACCESS_SECTIONS.find((s) => s.key === key).permissions), ...permissions];
      if (wanted.length === 0) throw new ValidationError([{ field: 'sections', message: 'Choose at least one section' }]);
      // Nobody hands out more than they hold themselves.
      const beyond = wanted.filter((permission) => !req.tenant.hasPermission(permission));
      if (beyond.length > 0) {
        throw new ValidationError([{ field: 'permissions', message: `You cannot give access you do not have: ${[...new Set(beyond)].join(', ')}` }]);
      }
      role = await roleFor(workspaceId, wanted, sections);
    }
    const membership = await workspaceService.inviteMember({ workspaceId, email, roleId: role.id }, req);
    res.status(201).json({
      membership: { id: membership.id, status: membership.status, invitedEmail: membership.invitedEmail },
      role: { id: role.id, key: role.key, name: role.name, permissions: role.permissions },
    });
  })
);

module.exports = router;
