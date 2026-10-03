'use strict';

const { AuthorizationError } = require('../errors/AppError');
const { hasPlatformPermission } = require('../security/platformPermissions');

/**
 * Gates for the platform-console endpoints. They bypass workspace RBAC
 * entirely and check only the account's own platform permission set
 * (users.platform_permissions, see core/security/platformPermissions.js).
 * Run after `authenticate` / `authenticateFlexible`, which reload the user
 * on every request, so a role change applies to that user's next call.
 *
 * Every /admin route names the permission it needs; there is deliberately no
 * "any platform user" gate, so a route cannot be left open to agents by
 * forgetting to narrow it.
 */
function requirePlatformPermission(permission) {
  return (req, res, next) => {
    if (!hasPlatformPermission(req.user, permission)) {
      return next(new AuthorizationError(`Missing required platform permission: ${permission}`));
    }
    next();
  };
}

module.exports = { requirePlatformPermission };
