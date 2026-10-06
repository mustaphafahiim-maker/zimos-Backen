'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./cartService');
const { readVisitorId } = require('../customerUploads/customerUploadService');
const { AppError } = require('../../core/errors/AppError');

/**
 * Cart identity travels via the X-Cart-Token header end to end (never a
 * body field or query param that could be forged more easily), and is
 * always looked up scoped to req.tenant.workspaceId — a guest token from
 * workspace A resolves to nothing in workspace B.
 */
function readToken(req) {
  return req.headers['x-cart-token'];
}

/** A signed-in shopper sees their price-list prices (priceLists/, item 205): the cart is read again with them. */
async function priced(req, cart) {
  const shopperToken = req.headers['x-shopper-token'];
  return shopperToken && cart && cart.id ? service.getCart(req.tenant.workspaceId, cart.id, { shopperToken }) : cart;
}

const getOrCreate = asyncHandler(async (req, res) => {
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, readToken(req));
  const full = await service.getCart(req.tenant.workspaceId, cart.id, { shopperToken: req.headers['x-shopper-token'] });
  res.status(201).json(full);
});

const getCurrent = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.json(await service.getCart(req.tenant.workspaceId, cart.id, { shopperToken: req.headers['x-shopper-token'] }));
});

const addItem = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  // Photos in the answers must be this visitor's own uploads.
  const visitorId = req.headers['x-visitor-id'] ? readVisitorId(req) : null;
  res.status(201).json(await priced(req, await service.addItem(req.tenant.workspaceId, cart.id, { ...req.body, visitorId })));
});

const updateItem = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.json(await priced(req, await service.updateItemQuantity(req.tenant.workspaceId, cart.id, req.params.itemId, req.body.quantity)));
});

const removeItem = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.json(await priced(req, await service.removeItem(req.tenant.workspaceId, cart.id, req.params.itemId)));
});

module.exports = { getOrCreate, getCurrent, addItem, updateItem, removeItem };
