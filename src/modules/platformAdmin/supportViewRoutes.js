'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { NotFoundError } = require('../../core/errors/AppError');
const support = require('../supportAccess/supportAccess');

/**
 * The store's own data as support sees it (SPEC §17.2 support access): team,
 * domains, connections, recent orders, alerts and activity. It opens only
 * while the merchant has let support in — `assertGranted` refuses with 403
 * SUPPORT_ACCESS_NOT_GRANTED otherwise — and each opening is written, with
 * the reason given, to the store's own activity log.
 *
 * POST (not GET) because every read is an audited act with a reason.
 * Mounted by platformAdminRoutes.js after `authenticate`.
 */

const router = Router();
const uuid = Joi.string().uuid();

const q = (sql, replacements) => db.sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

async function snapshot(workspaceId) {
  const [team, domains, carriers, gateways, integrations, orders, alerts, activity] = await Promise.all([
    q(
      `SELECT COALESCE(u.full_name, '') AS name, COALESCE(u.email, m.invited_email) AS email, r.name AS role, m.status, u.last_login_at AS "lastLoginAt"
         FROM memberships m JOIN roles r ON r.id = m.role_id LEFT JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = :workspaceId ORDER BY m.created_at`,
      { workspaceId }
    ),
    // Item 341: why a certificate failed, and a domain the domains job suspended (store_suspended | plan).
    q(`SELECT hostname, status, is_primary AS "isPrimary", ssl_status AS "sslStatus", ssl_detail AS "sslDetail", suspended_reason AS "suspendedReason" FROM domains WHERE workspace_id = :workspaceId ORDER BY created_at`, { workspaceId }),
    q(`SELECT carrier_code AS code, status, is_default AS "isDefault", last_verified_at AS "lastVerifiedAt" FROM carrier_accounts WHERE workspace_id = :workspaceId`, { workspaceId }),
    q(`SELECT provider_code AS code, mode, status, last_webhook_at AS "lastWebhookAt" FROM payment_gateway_accounts WHERE workspace_id = :workspaceId`, { workspaceId }),
    q(`SELECT provider AS code, status, last_error AS "lastError", last_verified_at AS "lastVerifiedAt" FROM workspace_integrations WHERE workspace_id = :workspaceId`, { workspaceId }),
    // No customer details: support sees what happened to an order, not who bought it.
    q(
      `SELECT id, order_number AS "orderNumber", confirmation_state AS "confirmationState", financial_state AS "financialState",
              fulfillment_state AS "fulfillmentState", payment_method AS "paymentMethod", total_amount AS "totalAmount", currency, source, created_at AS "createdAt"
         FROM orders WHERE workspace_id = :workspaceId AND is_test = false ORDER BY created_at DESC LIMIT 20`,
      { workspaceId }
    ),
    q(
      // One row per alert (each teammate got a copy), newest first.
      `SELECT type, title, "createdAt" FROM (
         SELECT DISTINCT ON (COALESCE(dedupe_key, id::text)) type, title, created_at AS "createdAt"
           FROM notifications WHERE workspace_id = :workspaceId AND type IN ('integration.failed', 'plan.limit_reached')
          ORDER BY COALESCE(dedupe_key, id::text), created_at DESC) a
        ORDER BY "createdAt" DESC LIMIT 10`,
      { workspaceId }
    ),
    q(
      `SELECT a.action, a.entity_type AS "entityType", a.created_at AS "createdAt", COALESCE(u.full_name, u.email) AS actor
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.workspace_id = :workspaceId ORDER BY a.created_at DESC LIMIT 20`,
      { workspaceId }
    ),
  ]);
  return { team, domains, connections: { carriers, gateways, integrations }, orders, alerts, activity };
}

router.post(
  '/workspaces/:workspaceId/support-view',
  can(P.SUPPORT_VIEW),
  validate({
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }),
  }),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'status', 'defaultCurrency', 'defaultLocale', 'timezone', 'createdAt'] });
    if (!workspace) throw new NotFoundError('Workspace');
    const grant = await support.assertGranted(workspaceId, { adminUserId: req.user.id, reason: req.body.reason, req });
    res.json({
      grant: support.view(grant),
      store: workspace.get({ plain: true }),
      ...(await snapshot(workspaceId)),
    });
  })
);

module.exports = router;
