'use strict';

const Joi = require('joi');
const { CATEGORIES } = require('./supportService');

const uuid = Joi.string().uuid();

// A message is plain text. The cap keeps a pasted log file from becoming a
// multi-megabyte row.
const body = Joi.string().trim().min(1).max(5000);

module.exports = {
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  open: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      subject: Joi.string().trim().min(3).max(200).required(),
      body: body.required(),
      category: Joi.string().valid(...CATEGORIES).default('general'),
    }),
  },
  get: { params: Joi.object({ workspaceId: uuid.required(), ticketId: uuid.required() }) },
  reply: {
    params: Joi.object({ workspaceId: uuid.required(), ticketId: uuid.required() }),
    body: Joi.object({ body: body.required() }),
  },
  messageBody: body,
};
