'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const exportService = require('./orderExportService');
const { recordAudit } = require('../audit/auditService');

const columns = asyncHandler(async (req, res) => {
  res.json(exportService.columnCatalogue());
});

/** Streams the CSV: a page of orders is written as soon as it is read. */
const exportCsv = asyncHandler(async (req, res) => {
  const { columns: requested, rowPer, lang, ...filters } = req.query;
  const { workspaceId } = req.tenant;

  // Dates are written on the store's own clock, not the server's.
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['timezone'] });
  const timezone = (workspace && workspace.timezone) || 'UTC';

  // The first chunk is produced before any header is sent, so a database
  // error still answers as a normal JSON error.
  const chunks = exportService.csvChunks(workspaceId, filters, { columns: requested, rowPer, lang, timezone });
  const first = await chunks.next();

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'order.export',
    entityType: 'Order',
    metadata: { filters, rowPer, columns: requested || 'default' },
    req,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  if (!first.done) res.write(first.value);
  for await (const chunk of chunks) res.write(chunk);
  res.end();
});

module.exports = { columns, exportCsv };
