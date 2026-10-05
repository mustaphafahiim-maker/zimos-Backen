'use strict';

const { randomUUID } = require('crypto');
const requestContext = require('../utils/requestContext');

// A caller's own X-Request-Id is kept only when it is a plain id: it is
// echoed back and written on every log line of the request.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function requestId(req, res, next) {
  const given = req.headers['x-request-id'];
  req.id = typeof given === 'string' && SAFE_ID.test(given) ? given : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // Everything the request does from here on logs with its id (core/utils/logger).
  requestContext.run({ requestId: req.id }, next);
}

module.exports = requestId;
