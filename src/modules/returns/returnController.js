'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./returnService');

const wid = (req) => req.tenant.workspaceId;

const create = asyncHandler(async (req, res) => {
  const ret = await service.createReturn(wid(req), req.params.orderId, req.body, req);
  res.status(201).json({ return: ret });
});

const listForOrder = asyncHandler(async (req, res) => {
  // A shopper's photos come with fresh signed links (shopperReturns.js).
  res.json({ returns: (await service.listReturnsForOrder(wid(req), req.params.orderId)).map(require('./shopperReturns').withPhotos) });
});

const list = asyncHandler(async (req, res) => {
  res.json({ returns: (await service.listReturns(wid(req), req.query)).map(require('./shopperReturns').withPhotos) });
});

const moderate = asyncHandler(async (req, res) => {
  res.json({ return: await service.moderateReturn(wid(req), req.params.returnId, req.body, req) });
});

const restock = asyncHandler(async (req, res) => {
  res.json({ return: await service.restockReturn(wid(req), req.params.returnId, req) });
});

// Item 372: the courier collects the parcel from the shopper (returnPickup.js).
const pickup = asyncHandler(async (req, res) => {
  const ret = await require('./returnPickup').bookPickup(wid(req), req.params.returnId, req.body, req);
  res.status(201).json({ return: require('./shopperReturns').withPhotos(ret) });
});

// Item 396: the pickup's status from the courier now, cancelling it, cancelling the return.
const syncPickup = asyncHandler(async (req, res) => {
  const ret = await require('./returnPickupStatus').syncPickup(wid(req), req.params.returnId);
  res.json({ return: require('./shopperReturns').withPhotos(ret) });
});

const cancelPickup = asyncHandler(async (req, res) => {
  const ret = await require('./returnPickup').cancelPickup(wid(req), req.params.returnId, req.body || {}, req);
  res.json({ return: require('./shopperReturns').withPhotos(ret) });
});

const cancel = asyncHandler(async (req, res) => {
  const ret = await require('./returnCancel').cancelReturn(wid(req), req.params.returnId, req.body || {}, req);
  res.json({ return: require('./shopperReturns').withPhotos(ret) });
});

module.exports = { create, listForOrder, list, moderate, restock, pickup, syncPickup, cancelPickup, cancel };
