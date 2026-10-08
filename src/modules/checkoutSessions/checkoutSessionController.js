'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./checkoutSessionService');

// Public: echoes nothing back but the id the storefront needs to send with
// its checkout. The rest is the shopper's own input or catalogue data.
const capture = asyncHandler(async (req, res) => {
  // The shopper's IP and its country, kept on the session like on an order (SPEC §6.1).
  const visitor = await require('../risk/visitorGate').describeVisitor(req);
  // And their language (X-Store-Locale, item 383), for the abandoned-cart email.
  visitor.locale = req.publicWorkspace ? require('../orders/orderLocale').fromRequest(req.publicWorkspace, req) : null;
  const session = await service.capture(req.tenant.workspaceId, req.body, visitor);
  res.json({ session: { id: session.id } });
});

const list = asyncHandler(async (req, res) => {
  res.json(await service.listSessions(req.tenant.workspaceId, req.query));
});

const update = asyncHandler(async (req, res) => {
  const session = await service.updateRecoveryStatus(req.tenant.workspaceId, req.params.sessionId, req.body, req);
  res.json({ session });
});

module.exports = { capture, list, update };
