'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./publicOrderService');

const wid = (req) => req.tenant.workspaceId;

/** Which store and what this key may do — the first call an integration makes. */
const me = asyncHandler(async (req, res) => {
  res.json({
    workspaceId: wid(req),
    apiKey: { id: req.apiKey.id, name: req.apiKey.name, keyPrefix: req.apiKey.keyPrefix, scopes: req.apiKey.scopes },
    actingAs: { id: req.user.id, fullName: req.user.fullName },
  });
});

const list = asyncHandler(async (req, res) => res.json(await service.listOrders(wid(req), req.query)));

const get = asyncHandler(async (req, res) => res.json({ order: await service.getOrder(wid(req), req.params.orderId) }));

const getByNumber = asyncHandler(async (req, res) =>
  res.json({ order: await service.getOrderByNumber(wid(req), req.params.orderNumber) })
);

const listShipments = asyncHandler(async (req, res) =>
  res.json({ shipments: await service.listShipments(wid(req), req.params.orderId) })
);

const confirmation = asyncHandler(async (req, res) =>
  res.json({ order: await service.setConfirmation(wid(req), req.params.orderId, req.body, req) })
);

const cancel = asyncHandler(async (req, res) =>
  res.json({ order: await service.cancelOrder(wid(req), req.params.orderId, req.body, req) })
);

const createShipment = asyncHandler(async (req, res) =>
  res.status(201).json({ shipment: await service.createShipment(wid(req), req.params.orderId, req.body, req) })
);

const updateShipment = asyncHandler(async (req, res) =>
  res.json({
    shipment: await service.updateShipment(wid(req), req.params.orderId, req.params.shipmentId, req.body, req),
  })
);

// Safe to repeat without an Idempotency-Key: a paid order is left as it is.
const codCollected = asyncHandler(async (req, res) =>
  res.json({ order: await service.markCodCollected(wid(req), req.params.orderId, req) })
);

module.exports = { me, list, get, getByNumber, listShipments, confirmation, cancel, createShipment, updateShipment, codCollected };
