'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * "Translate what's missing with AI" (SPEC §8.10, §10 Languages, §19):
 * the texts of one kind (products, collections, pages or funnels) that have
 * no translation in a language are sent to the AI `translate` feature in
 * batches of twenty — ordinary AI jobs, so the plan's AI limits, usage and
 * the provider (the sandbox until one is chosen) are the AI studio's.
 *
 *   POST /translations/ai         starts the jobs; each remembers which text
 *                                 every answer belongs to (input.targets)
 *   POST /translations/ai/apply   saves the answers of the jobs that finished;
 *                                 the dashboard calls it until none is pending
 *
 * An answer never overwrites a translation saved in the meantime: what the
 * merchant wrote wins. Saved translations are ordinary ones, edited and
 * cleared in the same screen.
 */

const BATCH = 20;
const MAX_BATCHES = 5;
// The AI feature's languages (ai/features.js DIALECTS) for each store language.
const TARGET = { ar: 'msa', en: 'english', fr: 'french' };

/** [{ target: "type|id|field", text }] still untranslated in `locale`. */
async function missingTexts(workspaceId, entityType, locale) {
  if (entityType === 'page' || entityType === 'funnel') {
    const items = await require('./contentTranslations').listContent(workspaceId, { entityType, locale });
    return items.flatMap((item) =>
      item.texts.filter((t) => !t.translation).map((t) => ({ target: `${entityType}|${item.entityId}|${t.key}`, text: t.source }))
    );
  }
  const items = await require('./translations').listItems(workspaceId, { entityType, locale });
  return items.flatMap((item) =>
    Object.entries(item.source)
      .filter(([field, text]) => text && text.trim() && !item.translation[field])
      .map(([field, text]) => ({ target: `${entityType}|${item.entityId}|${field}`, text: text.slice(0, 5000) }))
  );
}

async function start(workspaceId, { entityType, locale }, req) {
  const { languagesOf } = require('./translations');
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'] });
  const { defaultLocale, languages } = languagesOf(workspace);
  if (locale === defaultLocale || !languages.includes(locale)) {
    throw new AppError('LANGUAGE_NOT_OFFERED', 'Switch this language on for the store first', 422);
  }
  if (!TARGET[locale]) throw new AppError('AI_LANGUAGE_UNSUPPORTED', 'AI translation is available for Arabic, English and French', 422);

  const missing = await missingTexts(workspaceId, entityType, locale);
  const batches = [];
  for (let i = 0; i < missing.length && batches.length < MAX_BATCHES; i += BATCH) batches.push(missing.slice(i, i + BATCH));

  const aiService = require('../ai/aiService');
  const jobs = [];
  for (const batch of batches) {
    const fields = {};
    const targets = {};
    batch.forEach((m, i) => {
      fields[`f${i + 1}`] = m.text;
      targets[`f${i + 1}`] = m.target;
    });
    const job = await aiService.createJob(workspaceId, 'translate', { fields, targetLanguage: TARGET[locale] }, req);
    // Which text each answer is for, read back by apply().
    const row = await db.AiJob.findByPk(job.id);
    await row.update({ input: { ...row.input, targets, locale } });
    jobs.push(job.id);
  }
  return { jobs, texts: batches.reduce((n, b) => n + b.length, 0), remaining: Math.max(0, missing.length - BATCH * MAX_BATCHES) };
}

async function apply(workspaceId, { jobIds }, req) {
  const jobs = await db.AiJob.findAll({ where: { workspaceId, id: jobIds, feature: 'translate' } });
  let saved = 0;
  const pending = [];
  const failed = [];
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'running') {
      pending.push(job.id);
      continue;
    }
    if (job.status !== 'succeeded') {
      failed.push(job.id);
      continue;
    }
    if (job.applied) continue;
    const targets = (job.input && job.input.targets) || {};
    const locale = job.input && job.input.locale;
    const answers = (job.output && job.output.fields) || {};
    let count = 0;
    await db.sequelize.transaction(async (transaction) => {
      for (const [key, target] of Object.entries(targets)) {
        const value = typeof answers[key] === 'string' ? answers[key].trim() : '';
        if (!value || !locale) continue;
        const [entityType, entityId, field] = String(target).split('|');
        const where = { workspaceId, entityType, entityId, locale, field };
        // What the merchant saved since the job started stays.
        if (await db.Translation.findOne({ where, transaction })) continue;
        await db.Translation.create({ ...where, value: value.slice(0, 20000), updatedBy: req.user.id }, { transaction });
        count += 1;
      }
      await job.update({ applied: { type: 'translations', count } }, { transaction });
    });
    saved += count;
  }
  if (saved > 0) {
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'translation.ai_apply',
      entityType: 'AiJob',
      entityId: jobs[0].id,
      metadata: { jobs: jobs.length, saved },
      req,
    });
  }
  return { saved, pending, failed };
}

const uuid = Joi.string().uuid();
const locale = () =>
  Joi.string().custom((value, helpers) => (require('./translations').TRANSLATION_LOCALES.includes(value) ? value : helpers.error('any.only')));
const schemas = {
  start: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ entityType: Joi.string().valid('product', 'collection', 'page', 'funnel').required(), locale: locale().required() }),
  },
  apply: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ jobIds: Joi.array().items(uuid).min(1).max(MAX_BATCHES).required() }),
  },
};

// Inside the translations router (website.edit).
const router = Router({ mergeParams: true });
router.post('/ai', validate(schemas.start), asyncHandler(async (req, res) => res.status(202).json(await start(req.tenant.workspaceId, req.body, req))));
router.post('/ai/apply', validate(schemas.apply), asyncHandler(async (req, res) => res.json(await apply(req.tenant.workspaceId, req.body, req))));

module.exports = { router, start, apply, missingTexts };
