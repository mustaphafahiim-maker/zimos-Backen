'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { CUSTOM_CODE_SLOTS, MAX_CODE_LENGTH } = require('./customCodeService');

const uuid = Joi.string().uuid();

module.exports = {
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  save: {
    params: Joi.object({ workspaceId: uuid.required(), slot: Joi.string().valid(...CUSTOM_CODE_SLOTS).required() }),
    body: Joi.object({
      // Stored exactly as typed: this is code, so it is not trimmed.
      html: Joi.string().max(MAX_CODE_LENGTH).allow('').required(),
      isActive: Joi.boolean().required(),
    }),
  },
  publicList: { params: Joi.object({ workspaceId: workspaceRef().required() }) },
};
