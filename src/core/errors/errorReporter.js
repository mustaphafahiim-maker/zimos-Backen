'use strict';

const env = require('../../config/env');
const logger = require('../utils/logger');
const requestContext = require('../utils/requestContext');

/**
 * Where unexpected errors go besides the log (SPEC §3.5).
 *
 *   console  (default) the log line the caller already writes is the report
 *   sentry   SENTRY_DSN is set: the error goes to Sentry too, tagged with the
 *            request or job it happened in and the store (requestContext)
 *
 * Reported: 5xx answers (errorHandler), a queue job's last failed attempt
 * (core/queue), and unhandled rejections in the API and the worker. Expected
 * failures — validation, 4xx, a courier refusing a booking — are not.
 * Reporting never throws.
 */

let sentry = null;
const dsn = (process.env.SENTRY_DSN || '').trim();
if (dsn && !env.isTest) {
  try {
    // eslint-disable-next-line global-require
    sentry = require('@sentry/node');
    sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || env.nodeEnv,
      release: process.env.SENTRY_RELEASE || undefined,
      // Errors only: no performance tracing, no default PII.
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
    logger.info('Errors are reported to Sentry');
  } catch (err) {
    sentry = null;
    logger.warn(`SENTRY_DSN is set but Sentry could not start: ${err.message}`);
  }
}

const provider = () => (sentry ? 'sentry' : 'console');

/** Sends an unexpected error to the error tracker, with where it happened. */
function report(err, extra = {}) {
  if (!sentry || !err) return;
  try {
    const context = { ...(requestContext.current() || {}), ...extra };
    sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined && value !== null) scope.setTag(key, String(value).slice(0, 200));
      }
      sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch (reportErr) {
    logger.warn(`Could not report an error: ${reportErr.message}`);
  }
}

/** Waits (up to timeoutMs) for queued reports to leave, before a shutdown. */
async function flush(timeoutMs = 2000) {
  if (!sentry) return true;
  try {
    return await sentry.flush(timeoutMs);
  } catch (err) {
    return false;
  }
}

module.exports = { report, flush, provider };
