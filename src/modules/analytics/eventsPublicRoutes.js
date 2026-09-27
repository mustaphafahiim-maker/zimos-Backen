'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const controller = require('./storefrontEventsController');
const schemas = require('./storefrontEventsValidation');

// Mounted at /api/v1/store/:workspaceId/events — public, no staff auth.
// storefrontLimiter (app.js) already covers everything under /store.
const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

router.post('/', validate(schemas.ingest), controller.ingest);

module.exports = router;
