'use strict';

const crypto = require('crypto');
const { defineProvider, TrackingProviderError } = require('./providerContract');

/**
 * The test tracking provider: no network, the checkpoints follow from the
 * waybill alone, so every read of the same number gives the same history.
 *
 * Scripted numbers — `TRK-` then steps, oldest first, joined by `-`:
 *   IR info received   PU picked up   IT in transit   OD out for delivery
 *   FA failed attempt  DL delivered   RS returning    RT returned
 *   EX exception (kept as history, moves nothing)
 *   OLD<step>  the same step dated before every other one, and reported
 *              late: only from TRACKING_SANDBOX_LATE_SECONDS (default 30)
 *              after the number was registered, e.g. TRK-IT-OD-OLDIT
 *   TRK-ERR    the provider fails (to see the backoff)
 *   TRK-NONE   the provider has nothing yet
 *
 * Any other number goes by its last digit: 0–1 in transit; 2–3 out for
 * delivery; 4–6 delivered; 7 a failed attempt; 8 returned to the shop;
 * 9 nothing yet; no digit at the end: in transit.
 *
 * Checkpoint times end one minute before the number was registered, a minute
 * apart, so a number typed again later (a new registration) reads as newer.
 */

const STEPS = {
  IR: ['info_received', 'Shipment information received'],
  PU: ['picked_up', 'Picked up from the shop'],
  IT: ['in_transit', 'In transit to the delivery hub'],
  OD: ['out_for_delivery', 'Out for delivery'],
  FA: ['failed_attempt', 'Delivery attempted — customer not available'],
  DL: ['delivered', 'Delivered'],
  RS: ['returning', 'Returning to the shop'],
  RT: ['returned', 'Returned to the shop'],
  EX: ['exception', 'Held at the hub'],
};

const BY_DIGIT = {
  0: ['IT'], 1: ['IT'],
  2: ['IT', 'OD'], 3: ['IT', 'OD'],
  4: ['IT', 'OD', 'DL'], 5: ['IT', 'OD', 'DL'], 6: ['IT', 'OD', 'DL'],
  7: ['IT', 'OD', 'FA'],
  8: ['IT', 'FA', 'RS', 'RT'],
  9: [],
};

const refFor = (waybill) => `sbx_${crypto.createHash('sha1').update(String(waybill)).digest('hex').slice(0, 12)}`;

function script(waybill) {
  const number = String(waybill || '').trim().toUpperCase();
  const scripted = /^TRK-(.+)$/.exec(number);
  if (scripted) {
    if (scripted[1] === 'ERR') throw new TrackingProviderError('Sandbox tracking provider failed on purpose (TRK-ERR)');
    if (scripted[1] === 'NONE') return [];
    return scripted[1].split('-').filter(Boolean).map((token) => {
      const old = token.startsWith('OLD');
      const step = old ? token.slice(3) : token;
      if (!STEPS[step]) return { step: 'EX', old, unknown: token };
      return { step, old };
    });
  }
  const last = number.slice(-1);
  return (/\d/.test(last) ? BY_DIGIT[last] : ['IT']).map((step) => ({ step, old: false }));
}

module.exports = defineProvider({
  code: 'sandbox',
  name: 'Sandbox (test)',
  isSandbox: true,
  configured: () => true,

  async register({ waybill }) {
    return { ref: refFor(waybill) };
  },

  async fetch({ waybill, ref, registeredAt }) {
    const base = new Date(registeredAt || Date.now()).getTime();
    const lateMs = Math.max(0, parseInt(process.env.TRACKING_SANDBOX_LATE_SECONDS || '30', 10) || 0) * 1000;
    const reportedLate = Date.now() - base >= lateMs;
    const steps = script(waybill).map((s, index) => ({ ...s, index }));
    const inOrder = steps.filter((s) => !s.old).length;
    let i = 0;
    const checkpoints = steps.map((s) => {
      const [status, description] = STEPS[s.step];
      const at = s.old ? base - (inOrder + 5) * 60000 : base - (inOrder - i++) * 60000;
      return {
        key: `${ref || refFor(waybill)}:${s.index}:${s.unknown || (s.old ? 'OLD' : '') + s.step}`,
        at: new Date(at),
        status,
        code: s.step,
        description: s.unknown ? `${description} (${s.unknown})` : description,
        location: 'Sandbox hub',
      };
    });
    return { checkpoints: checkpoints.filter((cp, n) => !steps[n].old || reportedLate) };
  },
});
