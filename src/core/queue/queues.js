'use strict';

/**
 * The queues and how each one retries (SPEC §3.1). `delays[i]` is the wait
 * before attempt i+2; a job is tried `delays.length + 1` times, then `failed`.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const exponential = (retries, baseMs) => Array.from({ length: retries }, (_, i) => baseMs * 2 ** i);

const QUEUES = {
  // Hands every domain event to its consumers.
  events: { delays: exponential(4, 5 * SECOND) },
  // WhatsApp, SMS, email, push. A permanent 4xx is not retried.
  notifications: { delays: exponential(4, 15 * SECOND), stopOnClientError: true },
  // Server-side conversion events.
  pixels: { delays: exponential(2, 30 * SECOND) },
  // Deliveries to merchants' webhook endpoints.
  webhooks: { delays: [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 24 * HOUR] },
  // Create shipment, cancel, status sync.
  carriers: { delays: exponential(4, 30 * SECOND) },
  // Imports, exports, images: once, the job writes its own error report.
  io: { delays: [] },
  ai: { delays: [30 * SECOND] },
  // Anything that fits nowhere else.
  default: { delays: exponential(2, 10 * SECOND) },
};

const QUEUE_NAMES = Object.keys(QUEUES);

function policyFor(queue) {
  const policy = QUEUES[queue];
  if (!policy) throw new Error(`Unknown queue "${queue}" (known: ${QUEUE_NAMES.join(', ')})`);
  return policy;
}

/** True when retrying cannot help: the handler said so, or the far side answered a 4xx. */
function isPermanent(queue, err) {
  if (!err) return false;
  if (err.permanent === true) return true;
  if (!policyFor(queue).stopOnClientError) return false;
  const status = err.status ?? err.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429 && status !== 408;
}

module.exports = { QUEUES, QUEUE_NAMES, policyFor, isPermanent };
