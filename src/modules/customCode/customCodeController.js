'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./customCodeService');

const list = asyncHandler(async (req, res) => {
  res.json({ slots: await service.listSlots(req.tenant.workspaceId) });
});

const save = asyncHandler(async (req, res) => {
  res.json({ slot: await service.saveSlot(req.tenant.workspaceId, req.params.slot, req.body, req) });
});

// Public. A staff preview (any X-Store-Preview header, valid or not) gets no
// code at all: a preview carries a token, and merchant code must never run
// beside one.
const publicList = asyncHandler(async (req, res) => {
  const inPreview = Boolean(req.headers['x-store-preview']);
  res.json({
    slots: inPreview ? {} : await service.publicSlots(req.tenant.workspaceId),
    // Named scripts by position and page type (storeScripts.js); empty in a preview too.
    scripts: await require('./storeScripts').publicScripts(req),
  });
});

module.exports = { list, save, publicList };
