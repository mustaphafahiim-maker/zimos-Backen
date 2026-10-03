'use strict';

const db = require('../../db/models');
const { Op } = require('sequelize');
const logger = require('../../core/utils/logger');
const { normalizePhone } = require('../../core/utils/phone');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Form submissions (SPEC §18.4, "Contact Form Data"): every submit of a page
 * `form` element is kept, and a submit that carries a phone number also
 * becomes (or updates) a contact.
 *
 * The tags a form adds come from the published page, never from the request:
 * the shopper's browser only says which element was submitted, and the
 * element's own `tags` prop is read from the live snapshot. A shopper cannot
 * tag themselves into a segment the merchant did not set up.
 */

function cleanTags(tags) {
  return require('./contactService').cleanTags(tags);
}

function view(s) {
  return {
    id: s.id,
    customerId: s.customerId,
    formName: s.formName,
    pagePath: s.pagePath,
    fullName: s.fullName,
    phone: s.phone,
    email: s.email,
    message: s.message,
    data: s.data || {},
    tags: s.tags || [],
    marketingConsent: s.marketingConsent,
    isRead: s.isRead,
    createdAt: s.createdAt,
  };
}

function findFormNode(node, elementId, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findFormNode(child, elementId, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === 'form' && String(node.id) === elementId) return node;
  for (const key of Object.keys(node)) {
    if (key === 'props') continue;
    const value = node[key];
    if (value && typeof value === 'object') {
      const hit = findFormNode(value, elementId, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The form element as published: its name and the tags it adds. */
async function publishedForm(workspaceId, pagePath, elementId) {
  if (!elementId) return null;
  try {
    const found = await require('../pages/pagesService').getPublishedPageForStore(workspaceId, pagePath || '/');
    if (found.kind !== 'page') return null;
    const node = findFormNode(found.data.page.tree, String(elementId));
    if (!node) return null;
    const props = node.props || {};
    const tags = Array.isArray(props.tags) ? props.tags : String(props.tags || '').split(',');
    return { name: String(props.formName || props.title || '').trim(), tags: cleanTags(tags) };
  } catch (err) {
    // An unpublished page or a funnel step: the submission is still kept.
    return null;
  }
}

/**
 * `contact_form.submitted`. Until the outbox of lane 7 is on the trunk this
 * is the one place the event leaves from; it runs after the row is committed
 * and never fails the shopper's request.
 */
function emitSubmitted(submission) {
  setImmediate(() => {
    try {
      const outbox = require('../../core/events/outbox');
      Promise.resolve(
        outbox.record(null, 'contact_form.submitted', {
          workspaceId: submission.workspaceId,
          submissionId: submission.id,
          customerId: submission.customerId,
          formName: submission.formName,
        })
      ).catch((err) => logger.error(`[contacts] contact_form.submitted failed: ${err.message}`));
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') logger.error(`[contacts] contact_form.submitted failed: ${err.message}`);
    }
  });
}

async function submit(workspaceId, body, req) {
  // A filled honeypot is a bot: answer as if it worked, keep nothing.
  if (body.website) return { ok: true };

  const fullName = (body.name || '').trim() || null;
  const email = (body.email || '').trim().toLowerCase() || null;
  const message = (body.message || '').trim() || null;
  const phoneNormalized = body.phone ? normalizePhone(body.phone) : null;
  if (body.phone && !phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  if (!phoneNormalized && !email) {
    throw new AppError('CONTACT_REQUIRED', 'A phone number or an email is required', 422);
  }

  const form = await publishedForm(workspaceId, body.pagePath, body.elementId);
  const tags = form ? form.tags : [];
  const consent = Boolean(body.marketingConsent);

  const submission = await db.sequelize.transaction(async (transaction) => {
    let customer = null;
    if (phoneNormalized) {
      const [row, created] = await db.Customer.findOrCreate({
        where: { workspaceId, phoneNormalized },
        defaults: { workspaceId, phoneNormalized, phoneRaw: body.phone, fullName, email, tags, source: 'form', marketingConsent: consent },
        transaction,
      });
      customer = row;
      if (!created) {
        const updates = {};
        if (fullName && !row.fullName) updates.fullName = fullName;
        if (email && !row.email) updates.email = email;
        // Consent is only ever given here, never taken back by a form.
        if (consent && !row.marketingConsent) updates.marketingConsent = true;
        const merged = cleanTags([...(row.tags || []), ...tags]);
        if (merged.length !== (row.tags || []).length) updates.tags = merged;
        if (Object.keys(updates).length) await row.update(updates, { transaction });
      }
    }
    return db.FormSubmission.create(
      {
        workspaceId,
        customerId: customer ? customer.id : null,
        formName: (form && form.name) || (body.formName || '').trim() || 'Form',
        pagePath: body.pagePath || null,
        elementId: body.elementId || null,
        fullName,
        phone: phoneNormalized,
        email,
        message,
        data: body.fields || {},
        tags,
        marketingConsent: consent,
        ipAddress: req.ip || null,
      },
      { transaction }
    );
  });

  emitSubmitted(submission);
  return { ok: true };
}

async function listSubmissions(workspaceId, { limit = 50, cursor, formName, unreadOnly, q } = {}) {
  const where = { workspaceId };
  if (formName) where.formName = formName;
  if (unreadOnly) where.isRead = false;
  const text = String(q || '').trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    where[Op.or] = [
      { fullName: { [Op.iLike]: like } },
      { email: { [Op.iLike]: like } },
      { phone: { [Op.like]: `%${text.replace(/\D/g, '').replace(/^0+/, '') || '\u0000'}%` } },
      { message: { [Op.iLike]: like } },
    ];
  }
  if (cursor) {
    const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new AppError('INVALID_CURSOR', 'The cursor is not valid', 400);
    where[Op.and] = db.sequelize.literal(
      `("FormSubmission"."created_at", "FormSubmission"."id") < (${db.sequelize.escape(at)}, ${db.sequelize.escape(id)})`
    );
  }
  const rows = await db.FormSubmission.findAll({
    where,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const result = {
    submissions: page.map(view),
    nextCursor: rows.length > limit ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
  };
  if (!cursor) {
    const [forms, unread] = await Promise.all([
      db.FormSubmission.findAll({
        where: { workspaceId },
        attributes: ['formName', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
        group: ['formName'],
        order: [[db.sequelize.literal('count'), 'DESC']],
        raw: true,
      }),
      db.FormSubmission.count({ where: { workspaceId, isRead: false } }),
    ]);
    result.forms = forms.map((f) => ({ formName: f.formName, count: Number(f.count) }));
    result.unread = unread;
  }
  return result;
}

async function markRead(workspaceId, submissionId, isRead) {
  const submission = await scoped(db.FormSubmission, workspaceId, 'FormSubmission').findByPkOrThrow(submissionId);
  await submission.update({ isRead });
  return view(submission);
}

async function deleteSubmission(workspaceId, submissionId, req) {
  const submission = await scoped(db.FormSubmission, workspaceId, 'FormSubmission').findByPkOrThrow(submissionId);
  await submission.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'form_submission.delete',
    entityType: 'FormSubmission',
    entityId: submissionId,
    before: { formName: submission.formName, phone: submission.phone, email: submission.email },
    req,
  });
}

module.exports = { view, submit, listSubmissions, markRead, deleteSubmission };
