'use strict';

const Joi = require('joi');

const rangeQuery = Joi.object({
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
});

module.exports = {
  summary: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: rangeQuery,
  },
  funnels: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: rangeQuery,
  },
  funnelDetail: {
    params: Joi.object({
      workspaceId: Joi.string().uuid().required(),
      funnelId: Joi.string().uuid().required(),
    }),
    query: rangeQuery,
  },
};
