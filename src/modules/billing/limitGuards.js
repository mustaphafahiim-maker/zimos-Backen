'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError } = require('../../core/errors/AppError');
const planLimits = require('./planLimits');

/**
 * The plan limits on leads and file storage (SPEC §17.4), where they bite:
 *
 *   leads          new contacts collected by contact forms and the newsletter
 *                  in a calendar month. Over it, a NEW lead is refused (402
 *                  PLAN_LIMIT_REACHED); someone the store already knows is
 *                  never refused. The merchant hears about it once a month.
 *   storage_bytes  the media library plus digital product files. An upload
 *                  that would go past it is refused.
 *
 * No limit on the plan → nothing is checked (planLimits.limitFor).
 */

const refused = (key, allowed, used) =>
  new AppError('PLAN_LIMIT_REACHED', `Your plan allows ${allowed} of this. Upgrade the plan to add more.`, 402, { limit: key, allowed, used });

function tellMerchant(workspaceId, key, allowed) {
  const month = new Date().toISOString().slice(0, 7);
  const titles = {
    leads: `وصلت لحد العملاء المحتملين في باقتك (${allowed} هذا الشهر)`,
    storage_bytes: 'وصلت لحد مساحة التخزين في باقتك',
  };
  // eslint-disable-next-line global-require
  require('../notifications/merchantNotificationService')
    .create(workspaceId, {
      type: 'plan.limit_reached',
      title: titles[key] || 'وصلت لأحد حدود باقتك',
      body: key === 'leads' ? 'النماذج والنشرة البريدية لن تضيف عملاء جددًا حتى بداية الشهر القادم أو ترقية الباقة.' : 'احذف ملفات لا تحتاجها أو قم بترقية الباقة لرفع ملفات جديدة.',
      link: '/settings',
      data: { limit: key, allowed },
      dedupeKey: `plan.limit_reached:${key}:${month}`,
    })
    .catch((err) => logger.warn('Could not send a plan-limit notification', { workspaceId, key, message: err.message }));
}

/** Throws 402 when `phoneNormalized` would be a new lead past this month's limit. */
async function assertLeadRoom(workspaceId, phoneNormalized) {
  const allowed = await planLimits.limitFor(workspaceId, 'leads');
  if (allowed === null || !phoneNormalized) return;
  const known = await db.Customer.count({ where: { workspaceId, phoneNormalized } });
  if (known > 0) return;
  const used = await planLimits.usageFor(workspaceId, 'leads');
  if (used >= allowed) {
    tellMerchant(workspaceId, 'leads', allowed);
    throw refused('leads', allowed, used);
  }
}

/** Route guard after the upload is parsed (req.file): refuses a file that does not fit. */
function requireStorageRoom() {
  return async (req, res, next) => {
    try {
      const workspaceId = req.tenant.workspaceId;
      const allowed = await planLimits.limitFor(workspaceId, 'storage_bytes');
      if (allowed === null || !req.file) return next();
      const used = await planLimits.usageFor(workspaceId, 'storage_bytes');
      if (used + Number(req.file.size || 0) > allowed) {
        tellMerchant(workspaceId, 'storage_bytes', allowed);
        return next(refused('storage_bytes', allowed, used));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { assertLeadRoom, requireStorageRoom };
