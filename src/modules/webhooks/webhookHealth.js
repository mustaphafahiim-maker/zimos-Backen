'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');

/**
 * An endpoint that has done nothing but fail for three days is switched off
 * and the merchant is told (SPEC §16.1) — a dead receiver otherwise collects
 * retries for ever.
 *
 * `failing_since` marks the start of the current unbroken run of failures:
 * set by the first failed attempt, cleared by the next success.
 */

const DISABLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const REASON = 'failing_for_3_days';

/** Called by the dispatcher after every attempt. */
async function recordOutcome(endpoint, ok, now = new Date()) {
  if (ok) {
    if (endpoint.failingSince) await endpoint.update({ failingSince: null });
  } else if (!endpoint.failingSince) {
    await endpoint.update({ failingSince: now });
  }
}

/** The hourly job: switch off what has been failing for three days. */
async function disableFailing({ now = new Date() } = {}) {
  const endpoints = await db.WebhookEndpoint.findAll({
    where: { isActive: true, failingSince: { [Op.lte]: new Date(now.getTime() - DISABLE_AFTER_MS) } },
  });
  for (const endpoint of endpoints) {
    await endpoint.update({ isActive: false, disabledAt: now, disabledReason: REASON });
    await recordAudit({
      workspaceId: endpoint.workspaceId,
      action: 'webhook_endpoint.auto_disable',
      entityType: 'WebhookEndpoint',
      entityId: endpoint.id,
      before: { isActive: true },
      after: { isActive: false, disabledReason: REASON, failingSince: endpoint.failingSince },
    });
    try {
      let host = endpoint.url;
      try {
        host = new URL(endpoint.url).host;
      } catch (err) {
        // Keep the raw value.
      }
      // eslint-disable-next-line global-require
      await require('../notifications/merchantNotificationEvents').integrationFailed(endpoint.workspaceId, {
        integration: `Webhook ${host}`,
        message: 'تم إيقاف الـ webhook تلقائيًا بعد ٣ أيام من فشل الإرسال. أصلح العنوان ثم أعد تشغيله من الإعدادات.',
        link: '/settings?tab=developers',
      });
    } catch (err) {
      logger.error(`[webhooks] could not notify about disabled endpoint ${endpoint.id}: ${err.message}`);
    }
  }
  return { disabled: endpoints.length };
}

module.exports = { recordOutcome, disableFailing, DISABLE_AFTER_MS, REASON };
