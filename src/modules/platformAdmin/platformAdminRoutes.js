'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformAdmin } = require('../../core/middleware/platformAdminGuard');
const controller = require('./platformAdminController');
const schemas = require('./platformAdminValidation');

// Mounted at /api/v1/admin, alongside billing's adminRoutes (which owns
// /workspaces and /dashboard). Platform admin only — no workspace RBAC
// applies, so the guard runs for every route on this router.
const router = Router();
router.use(authenticate, requirePlatformAdmin);

// --- Plans ---------------------------------------------------------------
router.get('/plans', controller.listPlans);
router.post('/plans', validate(schemas.createPlan), controller.createPlan);
router.patch('/plans/:planId', validate(schemas.updatePlan), controller.updatePlan);
router.delete('/plans/:planId', validate(schemas.deletePlan), controller.deletePlan);

// --- Subscriptions -------------------------------------------------------
router.get('/subscriptions', validate(schemas.listSubscriptions), controller.listSubscriptions);

// --- Overview metrics ----------------------------------------------------
// No query parameters: the windows (30d / 30d / 12mo) are fixed by the
// contract, so there is nothing for a caller to vary and nothing to validate.
router.get('/metrics/overview', controller.getOverview);

// --- Audit log -----------------------------------------------------------
// Read-only by design: audit_logs is append-only (see modules/audit).
router.get('/audit-log', validate(schemas.listAuditLog), controller.listAuditLog);

// --- System services -----------------------------------------------------
// The POST performs no mutation; it is a POST because it deliberately bypasses
// the GET's cache and fires real third-party requests, which is not something
// a browser or proxy should be free to repeat on its own.
router.get('/system/services', controller.listServices);
router.post('/system/services/check', controller.checkServices);

// --- Feature flags -------------------------------------------------------
router.get('/feature-flags', controller.listFlags);
router.post('/feature-flags', validate(schemas.createFlag), controller.createFlag);
router.patch('/feature-flags/:flagId', validate(schemas.updateFlag), controller.updateFlag);
router.delete('/feature-flags/:flagId', validate(schemas.deleteFlag), controller.deleteFlag);

// --- Announcements -------------------------------------------------------
router.get('/announcements', controller.listAnnouncements);
router.post('/announcements', validate(schemas.createAnnouncement), controller.createAnnouncement);
router.patch('/announcements/:announcementId', validate(schemas.updateAnnouncement), controller.updateAnnouncement);
router.delete('/announcements/:announcementId', validate(schemas.deleteAnnouncement), controller.deleteAnnouncement);

// --- Templates -----------------------------------------------------------
// The gallery's write side. /api/v1/templates is public and read-only by
// design (it is the first screen after registration), so everything that
// changes a template lives here, behind the platform-admin guard.
router.get('/templates', validate(schemas.listTemplates), controller.listTemplates);
router.post('/templates', validate(schemas.createTemplate), controller.createTemplate);
router.get('/templates/:templateId', validate(schemas.templateParams), controller.getTemplate);
router.patch('/templates/:templateId', validate(schemas.updateTemplate), controller.updateTemplate);
router.delete('/templates/:templateId', validate(schemas.deleteTemplate), controller.deleteTemplate);
router.post('/templates/:templateId/publish', validate(schemas.templateParams), controller.publishTemplate);
router.post('/templates/:templateId/unpublish', validate(schemas.templateParams), controller.unpublishTemplate);
// Versions are immutable once written (websites are copied from them): they
// can be added and switched on or off, never edited or deleted.
router.post('/templates/:templateId/versions', validate(schemas.createTemplateVersion), controller.createTemplateVersion);
router.get('/templates/:templateId/versions/:versionId', validate(schemas.templateVersionParams), controller.getTemplateVersion);
router.patch('/templates/:templateId/versions/:versionId', validate(schemas.updateTemplateVersion), controller.updateTemplateVersion);

// --- Platform risk -------------------------------------------------------
// The blocklist is honoured by order creation in every workspace (see
// modules/risk/platformBlocklistService). Signals are read-only aggregates
// over existing orders; blocking one is a POST to the blocklist.
router.get('/risk/blocklist', validate(schemas.listBlocklist), controller.listBlocklist);
router.post('/risk/blocklist', validate(schemas.createBlocklistEntry), controller.createBlocklistEntry);
router.patch('/risk/blocklist/:entryId', validate(schemas.updateBlocklistEntry), controller.updateBlocklistEntry);
router.delete('/risk/blocklist/:entryId', validate(schemas.deleteBlocklistEntry), controller.deleteBlocklistEntry);
router.get('/risk/signals', validate(schemas.listRiskSignals), controller.listRiskSignals);

// --- Carriers and payment gateways (read-only registry) ------------------
// No enable/disable here: the environment (CARRIERS_*, PAYMENTS_*) is the
// only source of truth. The health-check POSTs mutate nothing — they are
// POSTs for the same reason as /system/services/check: they fire a real
// request at a third party and should not be repeated by a browser at will.
router.get('/carriers', controller.listCarriers);
router.post('/carriers/:code/health-check', validate(schemas.providerCode), controller.checkCarrier);
router.get('/payment-gateways', controller.listGateways);
router.post('/payment-gateways/:code/health-check', validate(schemas.providerCode), controller.checkGateway);

// --- Platform admins -------------------------------------------------------
// The users.platform_admin flag on existing accounts: no invitations, no
// roles. Self-revocation and revoking the last admin are refused.
router.get('/admins', controller.listAdmins);
router.post('/admins', validate(schemas.grantAdmin), controller.grantAdmin);
router.delete('/admins/:userId', validate(schemas.revokeAdmin), controller.revokeAdmin);

// --- Support tickets ---------------------------------------------------------
// The platform side of modules/support: the queue, replies, status/priority.
router.get('/support/tickets', validate(schemas.listTickets), controller.listTickets);
router.get('/support/tickets/:ticketId', validate(schemas.ticketParams), controller.getTicket);
router.post('/support/tickets/:ticketId/messages', validate(schemas.replyTicket), controller.replyTicket);
router.patch('/support/tickets/:ticketId', validate(schemas.updateTicket), controller.updateTicket);

module.exports = router;
