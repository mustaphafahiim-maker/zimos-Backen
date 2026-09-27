'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./platformAdminService');
const systemServices = require('./systemServicesService');
const overviewMetrics = require('./overviewMetricsService');
const templateService = require('../templates/templateService');
const platformBlocklist = require('../risk/platformBlocklistService');
const riskSignals = require('../risk/riskSignalsService');
const providerRegistry = require('./providerRegistryService');
const adminUsers = require('./adminUsersService');
const supportService = require('../support/supportService');

// Every handler here sits behind `authenticate` + `requirePlatformAdmin`.
// Collections are returned under a named key, matching the rest of the API.

// --- Plans ---------------------------------------------------------------
const listPlans = asyncHandler(async (req, res) => {
  res.json({ plans: await service.listPlans() });
});

const createPlan = asyncHandler(async (req, res) => {
  res.status(201).json({ plan: await service.savePlan(req.body, req) });
});

const updatePlan = asyncHandler(async (req, res) => {
  res.json({ plan: await service.savePlan({ ...req.body, id: req.params.planId }, req) });
});

const deletePlan = asyncHandler(async (req, res) => {
  res.json(await service.deletePlan(req.params.planId, req));
});

// --- Subscriptions -------------------------------------------------------
// The service returns the full envelope ({ subscriptions, mrr, mrrCurrency,
// mrrByCurrency }) — the total is computed there so the currency check cannot
// be skipped by a caller that only wants the rows.
const listSubscriptions = asyncHandler(async (req, res) => {
  res.json(await service.listSubscriptions({ status: req.query.status }));
});

// --- Overview metrics ----------------------------------------------------
// One object, not a collection, so it takes a named key of its own: the
// console's single-record unwrap requires `overview` and rejects a bare
// object loudly rather than guessing at it.
const getOverview = asyncHandler(async (req, res) => {
  res.json({ overview: await overviewMetrics.getOverview() });
});

// --- Audit log -----------------------------------------------------------
// The service already returns the full envelope ({ auditLog, total, page,
// pageSize }), so this passes it straight through.
const listAuditLog = asyncHandler(async (req, res) => {
  res.json(await service.listAuditLog(req.query));
});

// --- System services -----------------------------------------------------
// Both return the same { services: [...] } envelope and the same tile shape,
// so the console renders them through one path. The GET may serve a reading up
// to CACHE_TTL_MS old; the POST always probes for real.
const listServices = asyncHandler(async (req, res) => {
  res.json(await systemServices.listServices());
});

const checkServices = asyncHandler(async (req, res) => {
  res.json(await systemServices.checkServices());
});

// --- Feature flags -------------------------------------------------------
const listFlags = asyncHandler(async (req, res) => {
  res.json({ featureFlags: await service.listFlags() });
});

const createFlag = asyncHandler(async (req, res) => {
  res.status(201).json({ featureFlag: await service.saveFlag(req.body, req) });
});

const updateFlag = asyncHandler(async (req, res) => {
  res.json({ featureFlag: await service.saveFlag({ ...req.body, id: req.params.flagId }, req) });
});

const deleteFlag = asyncHandler(async (req, res) => {
  res.json(await service.deleteFlag(req.params.flagId, req));
});

// --- Announcements -------------------------------------------------------
const listAnnouncements = asyncHandler(async (req, res) => {
  res.json({ announcements: await service.listAnnouncements() });
});

const createAnnouncement = asyncHandler(async (req, res) => {
  res.status(201).json({ announcement: await service.saveAnnouncement(req.body, req) });
});

const updateAnnouncement = asyncHandler(async (req, res) => {
  res.json({
    announcement: await service.saveAnnouncement({ ...req.body, id: req.params.announcementId }, req),
  });
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  res.json(await service.deleteAnnouncement(req.params.announcementId, req));
});

// --- Templates -----------------------------------------------------------
// Delegated to the templates module: the public gallery reads the same rows,
// and one module owning what a Template means is what keeps the admin grid and
// the picker from drifting apart. These routes contribute the admin guard.
const listTemplates = asyncHandler(async (req, res) => {
  res.json({ templates: await templateService.listAllTemplates({ kind: req.query.kind }) });
});

const createTemplate = asyncHandler(async (req, res) => {
  res.status(201).json({ template: await templateService.saveTemplate(req.body, req) });
});

// { template, versions } — the row plus every version, newest first.
const getTemplate = asyncHandler(async (req, res) => {
  res.json(await templateService.getTemplateForAdmin(req.params.templateId));
});

const updateTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.saveTemplate({ ...req.body, id: req.params.templateId }, req) });
});

const deleteTemplate = asyncHandler(async (req, res) => {
  res.json(await templateService.deleteTemplate(req.params.templateId, req));
});

const publishTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.setPublished(req.params.templateId, true, req) });
});

const unpublishTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.setPublished(req.params.templateId, false, req) });
});

const createTemplateVersion = asyncHandler(async (req, res) => {
  res.status(201).json({ version: await templateService.createVersion(req.params.templateId, req.body, req) });
});

const getTemplateVersion = asyncHandler(async (req, res) => {
  res.json({ version: await templateService.getVersionForAdmin(req.params.templateId, req.params.versionId) });
});

const updateTemplateVersion = asyncHandler(async (req, res) => {
  const { templateId, versionId } = req.params;
  res.json({ version: await templateService.setVersionActive(templateId, versionId, req.body.isActive, req) });
});

// --- Platform risk -------------------------------------------------------
// Every write here is audited by the service, inside its own transaction.
const listBlocklist = asyncHandler(async (req, res) => {
  res.json(await platformBlocklist.listEntries(req.query));
});

// 201 for a new entry; 200 when the identifier was already listed and only
// its reason/expiry changed — the workspace blocklist's convention.
const createBlocklistEntry = asyncHandler(async (req, res) => {
  const { created, entry } = await platformBlocklist.blockIdentifier(req.body, req);
  res.status(created ? 201 : 200).json({ entry, created });
});

const updateBlocklistEntry = asyncHandler(async (req, res) => {
  res.json({ entry: await platformBlocklist.updateEntry(req.params.entryId, req.body, req) });
});

const deleteBlocklistEntry = asyncHandler(async (req, res) => {
  res.json(await platformBlocklist.deleteEntry(req.params.entryId, req));
});

const listRiskSignals = asyncHandler(async (req, res) => {
  res.json(await riskSignals.listSignals(req.query));
});

// --- Carriers and payment gateways -----------------------------------------
const listCarriers = asyncHandler(async (req, res) => {
  res.json(await providerRegistry.listCarriers());
});

const checkCarrier = asyncHandler(async (req, res) => {
  res.json({ check: await providerRegistry.checkCarrier(req.params.code) });
});

const listGateways = asyncHandler(async (req, res) => {
  res.json(await providerRegistry.listGateways());
});

const checkGateway = asyncHandler(async (req, res) => {
  res.json({ check: await providerRegistry.checkGateway(req.params.code) });
});

// --- Platform admins -------------------------------------------------------
const listAdmins = asyncHandler(async (req, res) => {
  res.json({ admins: await adminUsers.listAdmins(req.user.id) });
});

// 201 when the flag was granted; 200 when the account already had it.
const grantAdmin = asyncHandler(async (req, res) => {
  const { admin, granted } = await adminUsers.grantAdmin(req.body.email, req);
  res.status(granted ? 201 : 200).json({ admin, granted });
});

const revokeAdmin = asyncHandler(async (req, res) => {
  res.json(await adminUsers.revokeAdmin(req.params.userId, req));
});

// --- Support tickets ---------------------------------------------------------
const listTickets = asyncHandler(async (req, res) => {
  res.json(await supportService.listAllTickets(req.query));
});

const getTicket = asyncHandler(async (req, res) => {
  res.json(await supportService.getTicketForAdmin(req.params.ticketId));
});

const replyTicket = asyncHandler(async (req, res) => {
  res.status(201).json(await supportService.adminReply(req.params.ticketId, req.body, req));
});

const updateTicket = asyncHandler(async (req, res) => {
  res.json({ ticket: await supportService.updateTicket(req.params.ticketId, req.body, req) });
});

module.exports = {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  listSubscriptions,
  getOverview,
  listAuditLog,
  listServices,
  checkServices,
  listFlags,
  createFlag,
  updateFlag,
  deleteFlag,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  publishTemplate,
  unpublishTemplate,
  createTemplateVersion,
  getTemplateVersion,
  updateTemplateVersion,
  listBlocklist,
  createBlocklistEntry,
  updateBlocklistEntry,
  deleteBlocklistEntry,
  listRiskSignals,
  listCarriers,
  checkCarrier,
  listGateways,
  checkGateway,
  listAdmins,
  grantAdmin,
  revokeAdmin,
  listTickets,
  getTicket,
  replyTicket,
  updateTicket,
};
