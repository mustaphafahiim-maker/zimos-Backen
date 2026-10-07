'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const outbox = require('../../core/outbox/outbox');
const validate = require('../../core/middleware/validate');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { normalizePhone } = require('../../core/utils/phone');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const joiEmail = require('../../core/utils/joiEmail');
const { clientIp: clientIpOf } = require('../../core/middleware/clientIp');

/**
 * The opt-in step collects the visitor's details (SPEC §9.2: "Collect
 * name/email/mobile (Lead)"; §9.9: the step's Opt-ins).
 *
 *   POST /store/:ws/funnels/:funnelId/sessions/:sessionId/opt-in
 *        { fullName, phone?, email?, website?, botToken? } → { ok }
 *
 * The sign-up is kept like a page form's (contacts/formService.js): a form
 * submission named after the funnel and step, and a contact when it carries a
 * phone. A phone the store did not know is a new lead (`lead.created`, the
 * plan's leads limit). Signing up is asking to hear from the store, so the
 * contact gets marketing consent, as the form says beside its button. The
 * session keeps the sign-up under the step (`opt_ins`), and:
 *
 *   - the session cannot move past an opt-in step without one
 *     (funnelsService.advanceSession: OPT_IN_REQUIRED);
 *   - the step's Opt-ins count is these sign-ups, not every click on
 *     (analytics/funnelStepMetrics.js);
 *   - the storefront fires the ad platforms' Lead only once one is stored.
 *
 * The checkout's bot guard applies (checkoutSessions/autosaveGuard.js): a bot
 * is answered like a person and nothing is kept.
 */

async function currentOptInStep(workspaceId, funnelId, session) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['id', 'name', 'publishedRevisionId'] });
  if (!funnel || !funnel.publishedRevisionId) throw new NotFoundError('Funnel');
  const revision = await db.FunnelRevision.findOne({ where: { id: funnel.publishedRevisionId, funnelId }, attributes: ['snapshot'] });
  const steps = (revision && revision.snapshot && revision.snapshot.steps) || [];
  const step = steps.find((s) => s.key === session.currentStepKey);
  if (!step || step.stepType !== 'opt_in') throw new AppError('NOT_AN_OPT_IN_STEP', 'This step does not take a sign-up', 409);
  return { funnel, step };
}

async function optIn(workspace, funnelId, sessionId, body, req) {
  const workspaceId = workspace.id;
  const session = await db.FunnelSession.findOne({ where: { id: sessionId, funnelId, workspaceId } });
  if (!session) throw new NotFoundError('Funnel session');
  const { funnel, step } = await currentOptInStep(workspaceId, funnelId, session);

  const botProtection = require('../risk/botProtection');
  if (botProtection.settingsOf(workspace).enabled && require('../checkoutSessions/autosaveGuard').failedCheck(body, workspaceId)) {
    return { ok: true };
  }

  const fullName = body.fullName.trim();
  const email = body.email ? body.email.trim().toLowerCase() : null;
  const phoneNormalized = body.phone ? normalizePhone(body.phone) : null;
  if (body.phone && !phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  if (!phoneNormalized && !email) throw new AppError('CONTACT_REQUIRED', 'A phone number or an email is required', 422);
  // A new phone is a new lead: the plan's monthly leads limit (billing/limitGuards.js).
  await require('../billing/limitGuards').assertLeadRoom(workspaceId, phoneNormalized);

  await db.sequelize.transaction(async (transaction) => {
    const locked = await db.FunnelSession.findOne({ where: { id: session.id }, lock: transaction.LOCK.UPDATE, transaction });
    let customer = null;
    if (phoneNormalized) {
      const [row, created] = await db.Customer.findOrCreate({
        where: { workspaceId, phoneNormalized },
        defaults: { workspaceId, phoneNormalized, phoneRaw: body.phone, fullName, email, tags: ['opt_in'], source: 'funnel', marketingConsent: true },
        transaction,
      });
      customer = row;
      if (created) await outbox.record(transaction, 'lead.created', { workspaceId, customerId: row.id, source: 'funnel', funnelId });
      else {
        const updates = {};
        if (!row.fullName) updates.fullName = fullName;
        if (email && !row.email) updates.email = email;
        if (!row.marketingConsent) updates.marketingConsent = true;
        if (!(row.tags || []).includes('opt_in')) updates.tags = [...(row.tags || []), 'opt_in'];
        if (Object.keys(updates).length) await row.update(updates, { transaction });
      }
      // Signing up is opting back in after an earlier STOP (whatsapp/optOut.js).
      await db.MarketingOptOut.destroy({ where: { workspaceId, phoneNormalized }, transaction });
    }
    const submission = await db.FormSubmission.create(
      {
        workspaceId,
        customerId: customer ? customer.id : null,
        formName: `${funnel.name} · ${step.name || step.key}`.slice(0, 200),
        pagePath: `/f/${funnelId}/${step.key}`.slice(0, 500),
        elementId: null,
        fullName,
        phone: phoneNormalized,
        email,
        message: null,
        data: {},
        tags: ['opt_in'],
        marketingConsent: true,
        ipAddress: clientIpOf(req) || null,
      },
      { transaction }
    );
    await outbox.record(
      transaction,
      'contact_form.submitted',
      { workspaceId, submissionId: submission.id, customerId: submission.customerId, formName: submission.formName },
      { aggregateType: 'FormSubmission', aggregateId: submission.id }
    );
    await locked.update(
      { optIns: { ...(locked.optIns || {}), [step.key]: { submissionId: submission.id, customerId: customer ? customer.id : null, at: new Date().toISOString() } } },
      { transaction }
    );
  });
  return { ok: true };
}

/** For advanceSession: an opt-in step is left only once the session signed up on it. */
function assertOptedIn(step, session) {
  if (step && step.stepType === 'opt_in' && !(session.optIns && session.optIns[step.key])) {
    throw new AppError('OPT_IN_REQUIRED', 'Fill in your details to continue', 422);
  }
}

const limiter = createIpMinuteLimiter('funnel-opt-in', 6, { skip: () => env.isTest });
const router = Router({ mergeParams: true });
router.post(
  '/:funnelId/sessions/:sessionId/opt-in',
  limiter,
  validate({
    params: Joi.object({ workspaceId: Joi.string().required(), funnelId: Joi.string().uuid().required(), sessionId: Joi.string().uuid().required() }),
    body: Joi.object({
      fullName: Joi.string().trim().min(2).max(200).required(),
      phone: Joi.string().trim().max(32).allow('', null).optional(),
      email: joiEmail().allow('', null).optional(),
      // The bot guard's fields (autosaveGuard.js).
      website: Joi.string().max(500).allow('').optional(),
      botToken: Joi.string().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await optIn(req.publicWorkspace, req.params.funnelId, req.params.sessionId, req.body, req)))
);

module.exports = { router, optIn, assertOptedIn };
