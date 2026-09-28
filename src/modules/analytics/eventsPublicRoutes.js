'use strict';

const express = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { AppError } = require('../../core/errors/AppError');
const controller = require('./storefrontEventsController');
const schemas = require('./storefrontEventsValidation');

// A batch is at most 20 events (storefrontEventsValidation); even with every
// optional field filled it stays far below this. Anything bigger is refused
// while it is being read, instead of under the API-wide 2mb limit.
const MAX_BODY_BYTES = 64 * 1024;
const jsonParser = express.json({ limit: MAX_BODY_BYTES });

/**
 * Body parser for this route only. app.js mounts it before the API-wide
 * express.json, which then sees the body as already read and skips it.
 * Parser failures answer as client errors (413 / 400) rather than falling
 * through to the generic 500.
 */
function eventsBodyParser(req, res, next) {
  jsonParser(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return next(new AppError('PAYLOAD_TOO_LARGE', `Event batch is larger than ${MAX_BODY_BYTES} bytes`, 413));
    }
    if (err.status >= 400 && err.status < 500) {
      return next(new AppError('INVALID_BODY', 'The request body is not valid JSON', 400));
    }
    return next(err);
  });
}

// Mounted at /api/v1/store/:workspaceId/events — public, no staff auth.
// storefrontLimiter (app.js) already covers everything under /store; events
// are counted in their own buckets there so they never use up a shopper's
// cart and checkout budget (rateLimiters.js).
const router = express.Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

router.post('/', validate(schemas.ingest), controller.ingest);

module.exports = router;
module.exports.eventsBodyParser = eventsBodyParser;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
