'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const orderService = require('./orderService');
const stageChange = require('./orderStageChange');

/**
 * POST /orders/import-tracking — "Sync from file" (SPEC §4.3, §12.3): a
 * courier with no API sends the merchant a sheet of waybill numbers and
 * statuses, and the merchant uploads it here.
 *
 * CSV columns (header row required, any order, extra columns ignored):
 *   order_number      required
 *   tracking_number   the courier's waybill number
 *   tracking_url
 *   carrier           courier name, for an order that has no shipment yet
 *   status            created | shipped | picked_up | in_transit |
 *                     out_for_delivery | delivered | failed | returned
 *
 * Each row is applied on its own through the same operations the order page
 * uses — a manual shipment is created when the order has none, the tracking
 * is written onto it, the status goes through the stage guards — and the
 * answer reports every row, so a bad row never stops the file.
 */
const MAX_ROWS = 2000;

const STATUS_ALIASES = {
  created: 'created',
  shipped: 'in_transit',
  picked_up: 'picked_up',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  failed: 'failed',
  delivery_failed: 'failed',
  returned: 'returned',
};
const STAGE_FOR = { picked_up: 'shipped', in_transit: 'shipped', out_for_delivery: 'out_for_delivery', delivered: 'delivered', failed: 'delivery_failed', returned: 'returned' };

/** A small RFC-4180 reader: quoted fields, doubled quotes, commas or semicolons, CRLF. */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const normalizeHeader = (h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

async function applyRow(workspaceId, row, req) {
  const order = await db.Order.findOne({
    where: { workspaceId, orderNumber: row.orderNumber.replace(/^#/, '').toUpperCase() },
    attributes: ['id', 'orderNumber'],
  });
  if (!order) throw new AppError('ORDER_NOT_FOUND', 'No order with this number', 404);

  const status = row.status ? STATUS_ALIASES[row.status.toLowerCase().replace(/[\s-]+/g, '_')] : null;
  if (row.status && !status) throw new AppError('UNKNOWN_STATUS', `Unknown status "${row.status}"`, 422);

  const shipments = await db.Shipment.findAll({ where: { workspaceId, orderId: order.id }, order: [['createdAt', 'DESC'], ['id', 'DESC']] });
  let shipment = shipments.find((s) => !['cancelled', 'returned'].includes(s.status)) || null;

  const changes = [];
  if (!shipment) {
    shipment = await orderService.createShipment(
      workspaceId,
      order.id,
      // A waybill makes it a manual shipment whatever the courier name is.
      { carrierCode: row.carrier || 'manual', waybillNumber: row.trackingNumber || `IMP-${order.orderNumber}`, trackingUrl: row.trackingUrl || null },
      req
    );
    changes.push('shipment_created');
  } else if ((row.trackingNumber && row.trackingNumber !== shipment.waybillNumber) || (row.trackingUrl && row.trackingUrl !== shipment.trackingUrl)) {
    await orderService.updateShipment(
      workspaceId,
      order.id,
      shipment.id,
      { ...(row.trackingNumber ? { waybillNumber: row.trackingNumber } : {}), ...(row.trackingUrl ? { trackingUrl: row.trackingUrl } : {}) },
      req
    );
    changes.push('tracking_updated');
  }

  if (status && status !== 'created' && status !== shipment.status) {
    // Through the status endpoint's own path, so the move is guarded and
    // recorded exactly like one made on the order page.
    // Two shipment statuses can be one stage (picked up / in transit): nothing to move then.
    const moved = await stageChange
      .changeStage(workspaceId, order.id, { status: STAGE_FOR[status], reason: 'tracking import' }, req)
      .then(() => true)
      .catch((err) => {
        if (err && err.code === 'STATUS_UNCHANGED') return false;
        throw err;
      });
    if (moved) changes.push('status_updated');
  }
  return { orderId: order.id, changes };
}

async function importTracking(workspaceId, { csv, xlsx }, req) {
  let rows;
  if (xlsx) {
    // An Excel file from the courier's portal (item 260): cells read as text.
    const { parseXlsx, SheetError } = require('../catalog/importExport/sheetReader');
    try {
      rows = parseXlsx(Buffer.from(xlsx, 'base64')).map((r) => r.map((v) => String(v ?? '')));
    } catch (err) {
      if (err instanceof SheetError || /zip|central|signature/i.test(err.message)) throw new AppError('BAD_FILE', 'This is not an Excel (.xlsx) file', 422);
      throw err;
    }
    rows = rows.filter((r) => r.some((v) => v.trim() !== ''));
  } else {
    rows = parseCsv(csv);
  }
  if (rows.length < 2) throw new AppError('EMPTY_FILE', 'The file has no rows under its header', 422);
  const headers = rows[0].map(normalizeHeader);
  const col = (name) => headers.indexOf(name);
  if (col('order_number') === -1) {
    throw new AppError('MISSING_COLUMN', 'The file needs an "order_number" column', 422, { column: 'order_number' });
  }
  const data = rows.slice(1);
  if (data.length > MAX_ROWS) throw new AppError('TOO_MANY_ROWS', `At most ${MAX_ROWS} rows per file`, 422);

  const get = (r, name) => (col(name) === -1 ? '' : (r[col(name)] || '').trim());
  const results = [];
  for (const [index, r] of data.entries()) {
    const row = {
      orderNumber: get(r, 'order_number'),
      trackingNumber: get(r, 'tracking_number').slice(0, 100),
      trackingUrl: get(r, 'tracking_url').slice(0, 500),
      carrier: get(r, 'carrier').slice(0, 100),
      status: get(r, 'status'),
    };
    const line = index + 2;
    if (!row.orderNumber) {
      results.push({ line, orderNumber: null, ok: false, code: 'MISSING_ORDER_NUMBER', message: 'No order number on this row' });
      continue;
    }
    try {
      const { orderId, changes } = await applyRow(workspaceId, row, req);
      results.push({ line, orderNumber: row.orderNumber, orderId, ok: true, changes });
    } catch (err) {
      if (!err.isOperational) logger.error('Tracking import row failed unexpectedly', { workspaceId, line, message: err.message });
      results.push({
        line,
        orderNumber: row.orderNumber,
        ok: false,
        code: err.isOperational ? err.code : 'INTERNAL_SERVER_ERROR',
        message: err.isOperational ? err.message : 'Something went wrong with this row',
      });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { total: results.length, succeeded, failed: results.length - succeeded, results };
}

module.exports = { importTracking, parseCsv, MAX_ROWS };
