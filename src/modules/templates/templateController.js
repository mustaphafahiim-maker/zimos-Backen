'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./templateService');

const list = asyncHandler(async (req, res) => {
  // { templates, categories } — the filters and sort are in templateValidation.list.
  res.json(await service.listPublishedTemplates(req.query));
});

const get = asyncHandler(async (req, res) => {
  res.json({ template: await service.getTemplateDetail(req.params.id) });
});

module.exports = { list, get };
