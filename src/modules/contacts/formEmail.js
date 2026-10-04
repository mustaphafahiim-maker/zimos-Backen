'use strict';

const db = require('../../db/models');
const notify = require('../notifications/notify');
const { accountOf } = require('../workspaces/accountSettings');

/**
 * Emails one contact-form message to the store's contact-form address
 * (SPEC §17.3 "email for receiving contact forms"). Nothing is sent when
 * the store has not set one — the message is still in Form submissions.
 */
async function send(event) {
  const submissionId = event.payload && event.payload.submissionId;
  if (!submissionId) return null;
  const workspace = await db.Workspace.findByPk(event.workspaceId);
  const to = workspace && accountOf(workspace).contactFormEmail;
  if (!to) return null;
  const s = await db.FormSubmission.findOne({ where: { id: submissionId, workspaceId: event.workspaceId } });
  if (!s) return null;

  // A photo is only named here: staff open it in Form submissions (formFiles.js).
  const { data, files } = require('./formFiles').present(s.data && typeof s.data === 'object' ? s.data : {});
  const extra = [...Object.entries(data).map(([k, v]) => `${k}: ${v}`), ...files.map((f) => `${f.label}: صورة مرفقة`)];
  const lines = [
    s.fullName && `الاسم: ${s.fullName}`,
    s.phone && `الهاتف: ${s.phone}`,
    s.email && `البريد: ${s.email}`,
    ...extra,
    s.message && `\n${s.message}`,
  ].filter(Boolean);
  await notify.email({
    recipient: to,
    template: 'merchant_notification',
    data: {
      title: `رسالة جديدة من ${s.formName || 'نموذج التواصل'}${s.fullName ? ` — ${s.fullName}` : ''}`,
      body: lines.join('\n'),
      link: '/form-submissions',
    },
    workspaceId: event.workspaceId,
  });
  return { emailed: to };
}

module.exports = { send };
