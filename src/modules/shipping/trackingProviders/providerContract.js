'use strict';

/**
 * The contract a tracking provider implements (README.md in this folder).
 *
 *   code, name             'sandbox', 'aftership', …
 *   isSandbox              true only for the test provider
 *   configured()           whether this server has what the provider needs
 *                          (a platform API key from the environment)
 *   register({ waybill, courier })
 *       -> { ref, courier? }  tells the provider to follow a number; must be
 *                             safe to call again for a number it already has
 *   fetch({ waybill, courier, ref, registeredAt })
 *       -> { checkpoints: [Checkpoint], courier? }
 *
 * Checkpoint: { key, at: Date, status, code, description, location }
 *   key     stable id of the checkpoint (dedupe across reads)
 *   status  one of PROVIDER_STATUSES or null when it says nothing we map
 *
 * Errors: throw TrackingProviderError; `retryable` false for a refusal that
 * a retry will not fix (bad key, number rejected).
 */

const PROVIDER_STATUSES = Object.freeze([
  'info_received',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'failed_attempt',
  'delivered',
  'returning',
  'returned',
  'exception',
]);

// A provider status -> our shipment status. The rest are kept on the
// shipment's history (shipment_events) without moving its status.
const SHIPMENT_STATUS_FOR = Object.freeze({
  picked_up: 'picked_up',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  failed_attempt: 'failed',
  delivered: 'delivered',
  returned: 'returned',
});

class TrackingProviderError extends Error {
  constructor(message, { retryable = true, status = null } = {}) {
    super(message);
    this.name = 'TrackingProviderError';
    this.retryable = retryable;
    this.status = status;
  }
}

function defineProvider(spec) {
  const code = spec && spec.code;
  if (typeof code !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(code)) throw new Error(`Tracking provider "${code}": bad code`);
  for (const key of ['name', 'configured', 'register', 'fetch']) {
    if (spec[key] == null) throw new Error(`Tracking provider "${code}": missing ${key}`);
  }
  return Object.freeze({ isSandbox: false, ...spec });
}

module.exports = { PROVIDER_STATUSES, SHIPMENT_STATUS_FOR, TrackingProviderError, defineProvider };
