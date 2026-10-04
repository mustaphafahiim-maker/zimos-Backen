'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

module.exports = {
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ status: Joi.string().valid('pending', 'approved', 'rejected').optional() }),
  },
  moderate: {
    params: Joi.object({ workspaceId: uuid.required(), reviewId: uuid.required() }),
    body: Joi.object({ action: Joi.string().valid('approve', 'reject').required() }),
  },
};
