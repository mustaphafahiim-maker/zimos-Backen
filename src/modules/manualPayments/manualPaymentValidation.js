'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { normalizePhone } = require('../../core/utils/phone');

const uuid = Joi.string().uuid();
const wsParam = Joi.object({ workspaceId: uuid.required() });
const methodParam = Joi.object({ workspaceId: uuid.required(), methodId: uuid.required() });
const orderParam = Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() });
const storeParam = Joi.object({ workspaceId: workspaceRef().required() });
const storeOrderParam = Joi.object({ workspaceId: workspaceRef().required(), orderId: uuid.required() });

// The merchant's InstaPay account (a handle such as name@instapay, a phone or
// an account number) and a wallet's phone number. Spaces and dashes in a phone
// number are allowed as typed.
const INSTAPAY_ACCOUNT = /^[A-Za-z0-9@._+\- ]{3,80}$/;
const WALLET_NUMBER = /^\+?[\d\s-]{8,20}$/;

// Optional everywhere: empty or null means "no link" (stored as null); a
// given link must be https.
const paymentLink = Joi.string().trim().max(500).uri({ scheme: ['https'] }).allow('', null);

const accountNumber = Joi.when('kind', {
  is: 'wallet',
  then: Joi.string().trim().pattern(WALLET_NUMBER).messages({ 'string.pattern.base': '"accountNumber" must be a wallet phone number' }),
  otherwise: Joi.string().trim().pattern(INSTAPAY_ACCOUNT).messages({ 'string.pattern.base': '"accountNumber" must be an InstaPay account or number' }),
});

const methodFields = {
  label: Joi.string().trim().min(1).max(80),
  paymentLink,
  instructions: Joi.string().trim().max(1000).allow('', null),
  active: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0).max(10000),
};

// The number the shopper paid from: a phone (8–15 digits, optional +) or an
// InstaPay handle (name@bank). Spaces and dashes are taken out first; a phone
// is then stored as every other phone here, digits with the country code
// (core/utils/phone: "0101 234 5678" → 201012345678).
const PAYER_PHONE = /^\+?\d{8,15}$/;
const PAYER_HANDLE = /^[A-Za-z0-9._-]{2,40}@[A-Za-z0-9._-]{2,20}$/;
function normalizePayerNumber(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s-]/g, '');
  if (compact.length > 60) return null;
  if (PAYER_PHONE.test(compact)) return normalizePhone(compact) || null;
  return PAYER_HANDLE.test(compact) ? compact : null;
}

module.exports = {
  normalizePayerNumber,
  list: { params: wsParam },
  create: {
    params: wsParam,
    body: Joi.object({
      kind: Joi.string().valid('instapay', 'wallet').required(),
      accountNumber: accountNumber.required(),
      ...methodFields,
      label: methodFields.label.required(),
    }),
  },
  update: {
    params: methodParam,
    body: Joi.object({
      kind: Joi.string().valid('instapay', 'wallet'),
      // Checked against the row's kind too, in the service.
      accountNumber: Joi.string().trim().min(3).max(80),
      ...methodFields,
    }).min(1),
  },
  remove: { params: methodParam },
  reorder: {
    params: wsParam,
    body: Joi.object({ ids: Joi.array().items(uuid).min(1).max(50).unique().required() }),
  },
  order: { params: orderParam },
  reject: {
    params: orderParam,
    body: Joi.object({ reason: Joi.string().trim().min(1).max(500).required() }),
  },
  storeMethods: { params: storeParam },
  shopperStatus: { params: storeOrderParam },
};
