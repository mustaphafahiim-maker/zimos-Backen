'use strict';

const Joi = require('joi');

module.exports = {
  summary: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({
      from: Joi.date().iso().optional(),
      to: Joi.date().iso().optional(),
    }),
  },
};
