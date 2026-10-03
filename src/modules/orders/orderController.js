'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./orderService');
const confirmationService = require('../cod/confirmationService');
const stageChange = require('./orderStageChange');
const statusHistory = require('./orderStatusHistory');

const create = asyncHandler(async (req, res) => {
  const { order, items } = await service.createOrder(req.tenant.workspaceId, req.body, req);
  res.status(201).json({ order: { ...order.toJSON(), items } });
});

const get = asyncHandler(async (req, res) => {
  const order = await service.getOrder(req.tenant.workspaceId, req.params.orderId);
  res.json({ order });
});

const list = asyncHandler(async (req, res) => {
  const result = await service.listOrders(req.tenant.workspaceId, req.query);
  res.json(result);
});

const pipeline = asyncHandler(async (req, res) => {
  res.json(await service.orderPipeline(req.tenant.workspaceId, req.query));
});

const cancel = asyncHandler(async (req, res) => {
  const order = await service.cancelOrder(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order });
});

// Confirm from the order page: the same outcome a queue call records.
const confirm = asyncHandler(async (req, res) => {
  const task = await confirmationService.confirmFromOrder(req.tenant.workspaceId, req.params.orderId, req.body, req);
  const order = await service.getOrder(req.tenant.workspaceId, req.params.orderId);
  res.json({ order, task });
});

const changeStatus = asyncHandler(async (req, res) => {
  const order = await stageChange.changeStage(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order });
});

const listStatusHistory = asyncHandler(async (req, res) => {
  // 404 for an order of another workspace, before any history is read.
  await service.getOrderRef(req.tenant.workspaceId, req.params.orderId);
  res.json({ history: await statusHistory.listForOrder(req.tenant.workspaceId, req.params.orderId) });
});

const update = asyncHandler(async (req, res) => {
  const order = await service.updateOrderLimited(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order });
});

const listShipments = asyncHandler(async (req, res) => {
  res.json({ shipments: await service.listShipments(req.tenant.workspaceId, req.params.orderId) });
});

const createShipment = asyncHandler(async (req, res) => {
  const shipment = await service.createShipment(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.status(201).json({ shipment });
});

const updateShipment = asyncHandler(async (req, res) => {
  const shipment = await service.updateShipment(
    req.tenant.workspaceId,
    req.params.orderId,
    req.params.shipmentId,
    req.body,
    req
  );
  res.json({ shipment });
});

module.exports = {
  create,
  get,
  list,
  pipeline,
  cancel,
  confirm,
  changeStatus,
  listStatusHistory,
  update,
  listShipments,
  createShipment,
  updateShipment,
};
