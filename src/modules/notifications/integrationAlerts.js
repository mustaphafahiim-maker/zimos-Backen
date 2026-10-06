'use strict';

const logger = require('../../core/utils/logger');

/**
 * "A connected service stopped working" (SPEC §14.6 integration failed:
 * gateway, shipping, WhatsApp) — the merchant hears about it from the bell
 * and by email instead of from a customer.
 *
 * Only failures of the connection itself count: rejected credentials, a
 * missing permission, a service that does not answer, webhooks whose
 * signature does not match the stored secret. A declined card, an address
 * the courier refuses or an undeliverable WhatsApp number are a shopper's
 * outcome and stay where they are.
 *
 * One notification per integration and reason a day. Never throws and
 * never waits on the caller: a notification must not fail or slow the
 * payment, shipment or message that ran into the problem.
 */

const REASONS = {
  auth: 'المفتاح أو بيانات الدخول لم تعد مقبولة. أعد الربط من الإعدادات.',
  permission: 'الحساب لا يملك صلاحية لهذا الإجراء. راجع صلاحيات المفتاح لدى مزوّد الخدمة.',
  unavailable: 'الخدمة لم ترد. يُعاد المحاولة تلقائيًا، وإن استمر ذلك تواصل مع مزوّد الخدمة.',
  signature: 'وصلت إشعارات لم يتطابق توقيعها مع المفتاح المحفوظ. تأكد من مفتاح الـ webhook في الإعدادات.',
};

const GATEWAY_REASONS = { GATEWAY_AUTH_FAILED: 'auth', GATEWAY_CREDENTIALS_UNREADABLE: 'auth', GATEWAY_ERROR: 'unavailable' };
const CARRIER_REASONS = { CARRIER_AUTH_FAILED: 'auth', CARRIER_CREDENTIALS_UNREADABLE: 'auth', CARRIER_PERMISSION_DENIED: 'permission' };
const WHATSAPP_REASONS = { WHATSAPP_AUTH_FAILED: 'auth', WHATSAPP_UNREACHABLE: 'unavailable' };

const today = () => new Date().toISOString().slice(0, 10);

function send(workspaceId, { kind, code, name, reason, link, errorCode }) {
  if (!workspaceId || !reason) return;
  // eslint-disable-next-line global-require
  const notifications = require('./merchantNotificationService');
  Promise.resolve()
    .then(() =>
      notifications.create(workspaceId, {
        type: 'integration.failed',
        title: `تعذّر الاتصال بـ ${name}`,
        body: REASONS[reason],
        link,
        data: { integration: name, kind, code, reason, errorCode: errorCode || null },
        dedupeKey: `integration.failed:${kind}:${code}:${reason}:${today()}`,
      })
    )
    .catch((err) => logger.error('Could not send an integration alert', { workspaceId, kind, code, message: err.message }));
}

/** A payment gateway call failed (checkout, refund, status check). */
function gateway(workspaceId, providerCode, err) {
  const reason = err && GATEWAY_REASONS[err.code];
  if (!reason) return;
  // eslint-disable-next-line global-require
  const adapter = require('../payments/gateways').getAdapter(providerCode);
  send(workspaceId, { kind: 'gateway', code: providerCode, name: (adapter && adapter.name) || providerCode, reason, link: '/payments', errorCode: err.code });
}

/** A courier call failed on the connection itself (any call made through withAuthHandling). */
function carrier(workspaceId, carrierCode, err) {
  const reason = err && CARRIER_REASONS[err.code];
  if (!reason) return;
  // eslint-disable-next-line global-require
  const adapter = require('../shipping/carriers').getAdapter(carrierCode);
  send(workspaceId, { kind: 'carrier', code: carrierCode, name: (adapter && adapter.name) || carrierCode, reason, link: '/shipping', errorCode: err.code });
}

/** A WhatsApp Cloud API call failed on the connection (token, reachability). */
function whatsapp(workspaceId, err) {
  const reason = err && WHATSAPP_REASONS[err.code];
  if (!reason) return;
  send(workspaceId, { kind: 'whatsapp', code: 'whatsapp_cloud', name: 'WhatsApp', reason, link: '/settings#whatsapp', errorCode: err.code });
}

/** Webhooks from a connected service whose signature does not match the stored secret. */
function badSignature(workspaceId, { kind, code, name, link }) {
  send(workspaceId, { kind, code, name, reason: 'signature', link });
}

module.exports = { gateway, carrier, whatsapp, badSignature, REASONS };
