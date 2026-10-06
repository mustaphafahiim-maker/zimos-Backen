'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { maskPhone } = require('../../core/utils/phoneMask');

/**
 * The leads sheet (SPEC §16.4 "data type (orders, lost, leads)"): one row per
 * sign-up, from a store contact form or a funnel's opt-in step — the
 * form_submissions row each one leaves (contacts/formService.js,
 * funnels/funnelOptIn.js), announced by `contact_form.submitted`. A sign-up
 * does not change afterwards, so its row is written once.
 */

const LEAD_COLUMNS = [
  { key: 'date', en: 'Date', ar: 'التاريخ', value: (l, x) => x.date(l.createdAt) },
  { key: 'form', en: 'Form', ar: 'النموذج', value: (l) => l.formName || '' },
  { key: 'customerName', en: 'Name', ar: 'الاسم', value: (l) => l.fullName || '' },
  { key: 'phone', en: 'Phone', ar: 'الموبايل', value: (l) => l.phone || '' },
  { key: 'email', en: 'Email', ar: 'البريد', value: (l) => l.email || '' },
  { key: 'message', en: 'Message', ar: 'الرسالة', value: (l) => l.message || '' },
  { key: 'tags', en: 'Tags', ar: 'الوسوم', value: (l) => (l.tags || []).join(', ') },
  { key: 'consent', en: 'Marketing consent', ar: 'موافقة التسويق', value: (l, x) => x.label(YES_NO, l.marketingConsent ? 'yes' : 'no') },
  { key: 'page', en: 'Page', ar: 'الصفحة', value: (l) => l.pagePath || '' },
];
const YES_NO = { yes: ['Yes', 'نعم'], no: ['No', 'لا'] };
const LEAD_KEYS = LEAD_COLUMNS.map((c) => c.key);
const byKey = new Map(LEAD_COLUMNS.map((c) => [c.key, c]));

// A funnel's opt-in step keeps the page as /f/<funnelId>/<step> (funnelOptIn.js).
const funnelOf = (lead) => {
  const match = /^\/f\/([0-9a-f-]{36})\//i.exec(lead.pagePath || '');
  return match ? match[1] : null;
};

function leadRow(lead, connection, x) {
  const filter = connection.filter || {};
  const shaped = filter.maskPhones ? { ...lead, phone: maskPhone(lead.phone) } : lead;
  return connection.columns.map((entry) => {
    if (!entry.key) return entry.fixed || '';
    const column = byKey.get(entry.key);
    return column ? String(column.value(shaped, x) ?? '') : '';
  });
}

/** A funnels filter keeps the sign-ups made on those funnels only. */
function leadMatches(connection, lead) {
  const ids = (connection.filter || {}).funnelIds;
  return !(Array.isArray(ids) && ids.length) || ids.includes(funnelOf(lead));
}

async function loadLead(workspaceId, submissionId) {
  const row = await db.FormSubmission.findOne({ where: { id: submissionId, workspaceId } });
  if (!row) {
    const err = new Error('Form submission not found');
    err.statusCode = 404;
    throw err;
  }
  return row.get({ plain: true });
}

/** "Sync existing": the sign-ups since then, oldest first. */
async function leadIdsSince(workspaceId, since, limit) {
  const rows = await db.FormSubmission.findAll({
    where: { workspaceId, createdAt: { [Op.gte]: since } },
    attributes: ['id'],
    order: [['createdAt', 'ASC']],
    limit,
  });
  return rows.map((r) => r.id);
}

module.exports = { LEAD_COLUMNS, LEAD_KEYS, leadRow, leadMatches, loadLead, leadIdsSince };
