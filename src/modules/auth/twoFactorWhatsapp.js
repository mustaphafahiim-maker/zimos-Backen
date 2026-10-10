'use strict';

const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');

/**
 * The WhatsApp sign-in code. It goes to the account's verified phone
 * through the authentication template; when WhatsApp cannot deliver it the
 * code goes by SMS, and with no phone left on the account by email, so a
 * person is never locked out by a messaging outage.
 */

const maskPhone = (phone) => `${String(phone).slice(0, 4)}${'*'.repeat(Math.max(2, String(phone).length - 7))}${String(phone).slice(-3)}`;

/** mode = 'whatsapp': only with a verified phone (auth/verify-phone). */
async function enable(user, row, req) {
  if (!user.phone || !user.phoneVerifiedAt) {
    throw new AppError('PHONE_NOT_VERIFIED', 'Verify your phone number first: the code is sent to it on WhatsApp', 409);
  }
  await row.update({ mode: 'whatsapp', totpSecretSealed: null, pendingSecretSealed: null, enabledAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.two_factor_enable', entityType: 'User', entityId: user.id, after: { mode: 'whatsapp' }, req });
}

/**
 * Sends a sign-in code to the phone. Returns { channel, sentTo } for the
 * answer, or null when the account has no verified phone any more (the
 * caller emails it instead).
 */
async function sendCode(user, code, { minutes, locale }) {
  if (!user.phone || !user.phoneVerifiedAt) return null;
  const message = { recipient: user.phone, template: 'login_code', data: { code, minutes, locale } };
  const whatsapp = await notify.whatsapp(message);
  if (!whatsapp || whatsapp.status !== 'failed') return { channel: 'whatsapp', sentTo: maskPhone(user.phone) };
  const sms = await notify.sms(message);
  if (!sms || sms.status !== 'failed') return { channel: 'sms', sentTo: maskPhone(user.phone) };
  return null;
}

module.exports = { enable, sendCode, maskPhone };
