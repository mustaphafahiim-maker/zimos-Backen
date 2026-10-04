'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../db/models');
const queue = require('../../core/queue');
const logger = require('../../core/utils/logger');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { validatePageTree } = require('../pages/pageTree');
const { FEATURES, allowedElements } = require('./features');
const { getProvider, describeProvider } = require('./providers');

/**
 * The AI module (SPEC §19). A request becomes a job on the `ai` queue; the
 * dashboard polls the job. The provider's answer is validated against the
 * feature's schema before it is stored, and what it produces is only ever a
 * draft: "Apply" makes a draft product or an unpublished page.
 *
 * Provider contract: README.md in this folder.
 */

const { Op } = db.Sequelize;
// Abuse guard, independent of any plan: a store cannot fire more than this per hour.
const HOURLY_GUARD = 30;
const PLAN_LIMIT_KEY = 'ai_requests_per_month';

const promptCache = new Map();
function loadPrompt(name) {
  if (!promptCache.has(name)) promptCache.set(name, fs.readFileSync(path.join(__dirname, 'prompts', `${name}.md`), 'utf8'));
  return promptCache.get(name);
}

function renderPrompt(name, values) {
  return loadPrompt(name).replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key) => {
    if (!(key in values)) return whole;
    const value = values[key];
    if (value === null || value === undefined || value === '') return '—';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The plan's monthly request limit, or null when the plan sets none. */
async function monthlyLimit(workspaceId) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'features'] }],
  });
  const features = subscription && subscription.plan ? subscription.plan.features : null;
  const raw = features && !Array.isArray(features) ? features[PLAN_LIMIT_KEY] : undefined;
  const limit = Number(raw);
  return raw !== undefined && raw !== null && raw !== true && Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : null;
}

async function usage(workspaceId) {
  const since = monthStart();
  const [rows, limit] = await Promise.all([
    db.AiUsage.findAll({
      where: { workspaceId, createdAt: { [Op.gte]: since } },
      attributes: [
        'type',
        [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'requests'],
        [db.sequelize.fn('SUM', db.sequelize.literal('tokens_in + tokens_out')), 'tokens'],
      ],
      group: ['type'],
      raw: true,
    }),
    monthlyLimit(workspaceId),
  ]);
  const byType = rows.map((r) => ({ type: r.type, requests: Number(r.requests), tokens: Number(r.tokens || 0) }));
  const used = byType.reduce((sum, r) => sum + r.requests, 0);
  return {
    provider: describeProvider(),
    month: since.toISOString().slice(0, 7),
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    tokens: byType.reduce((sum, r) => sum + r.tokens, 0),
    byType,
  };
}

async function assertWithinLimits(workspaceId) {
  const [limit, monthCount, hourCount] = await Promise.all([
    monthlyLimit(workspaceId),
    // Jobs, not usage rows: a request still running counts against the limit too.
    db.AiJob.count({ where: { workspaceId, status: { [Op.ne]: 'failed' }, createdAt: { [Op.gte]: monthStart() } } }),
    db.AiJob.count({ where: { workspaceId, createdAt: { [Op.gte]: new Date(Date.now() - 3600 * 1000) } } }),
  ]);
  if (limit !== null && monthCount >= limit) {
    throw new AppError('AI_LIMIT_REACHED', 'This month’s AI requests are used up', 429, { limit, used: monthCount, scope: 'month' });
  }
  if (hourCount >= HOURLY_GUARD) {
    throw new AppError('AI_LIMIT_REACHED', 'Too many AI requests in the last hour. Try again later.', 429, {
      limit: HOURLY_GUARD,
      used: hourCount,
      scope: 'hour',
    });
  }
}

function jobView(job) {
  return {
    id: job.id,
    feature: job.feature,
    status: job.status,
    input: job.input,
    output: job.status === 'succeeded' ? job.output : null,
    error: job.status === 'failed' ? job.error : null,
    provider: job.provider,
    applied: job.applied,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** Starts a generation. Returns the queued job; poll getJob for the result. */
async function createJob(workspaceId, feature, rawInput, req) {
  const spec = FEATURES[feature];
  if (!spec) throw new NotFoundError('AI feature');
  const { value: input, error } = spec.input.validate(rawInput || {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError('VALIDATION_ERROR', 'Invalid body', 422, error.details.map((d) => ({ field: d.path.join('.'), message: d.message })));
  }
  // Fails here, not in the queue, when no provider can answer.
  const provider = getProvider();
  if (feature === 'page') await scoped(db.Product, workspaceId, 'Product').findByPkOrThrow(input.productId);
  await assertWithinLimits(workspaceId);

  const job = await db.AiJob.create({
    workspaceId,
    userId: req.user.id,
    feature,
    input,
    status: 'queued',
    provider: provider.name,
    promptVersion: spec.prompt,
  });
  await queue.add('ai', 'ai.generate', { jobId: job.id }, { workspaceId });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'ai.request',
    entityType: 'AiJob',
    entityId: job.id,
    metadata: { feature },
    req,
  });
  return jobView(job);
}

/** What the prompt needs beyond the merchant's input, read on the server. */
async function buildContext(job) {
  if (job.feature !== 'page') return {};
  const product = await db.Product.findOne({ where: { id: job.input.productId, workspaceId: job.workspaceId } });
  if (!product) {
    const err = new Error('The product no longer exists');
    err.permanent = true;
    throw err;
  }
  const cms = product.cms || {};
  const first = Array.isArray(product.media) ? product.media[0] : null;
  return {
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description || '',
      imageUrl: (first && (first.url || first.src)) || null,
      features: Array.isArray(cms.features) ? cms.features.map((f) => ({ title: f.title, description: f.description || '' })) : [],
      faqs: Array.isArray(cms.faqs) ? cms.faqs.map((f) => ({ question: f.question, answer: f.answer })) : [],
    },
    allowedElements: allowedElements(),
  };
}

function validateOutput(feature, output) {
  const { value, error } = FEATURES[feature].output.validate(output, { abortEarly: false, stripUnknown: true });
  if (error) {
    const err = new Error(`The AI answer did not have the expected shape (${error.details[0].message})`);
    err.permanent = true;
    throw err;
  }
  if (feature === 'page') {
    try {
      validatePageTree(value.tree, { requireContent: true, label: 'generated page' });
    } catch (cause) {
      const detail = cause.details && cause.details[0] ? `${cause.details[0].field}: ${cause.details[0].message}` : cause.message;
      const err = new Error(`The AI answer was not a valid page (${detail})`);
      err.permanent = true;
      throw err;
    }
  }
  return value;
}

/** The `ai` queue processor: one job, start to finish. */
async function runJob(jobId, { lastAttempt = true } = {}) {
  const job = await db.AiJob.findByPk(jobId);
  if (!job || job.status === 'succeeded') return;
  await job.update({ status: 'running' });
  try {
    const provider = getProvider();
    const context = await buildContext(job);
    // Product photos (SPEC §19.2 "Images + name"): counted in the prompt, sent to the model as images.
    const images = Array.isArray(job.input && job.input.imageUrls) ? job.input.imageUrls : [];
    const prompt = renderPrompt(job.promptVersion, { ...job.input, photoCount: images.length, ...context });
    const answer = await provider.generate({
      feature: job.feature,
      prompt,
      promptVersion: job.promptVersion,
      input: job.input,
      images,
      context,
      workspaceId: job.workspaceId,
      jobId: job.id,
    });
    const output = validateOutput(job.feature, answer && answer.output);
    const used = (answer && answer.usage) || {};
    await db.sequelize.transaction(async (transaction) => {
      await job.update({ status: 'succeeded', output, error: null, provider: provider.name, finishedAt: new Date() }, { transaction });
      await db.AiUsage.create(
        {
          workspaceId: job.workspaceId,
          jobId: job.id,
          type: job.feature,
          provider: provider.name,
          tokensIn: Math.max(0, Math.floor(used.tokensIn || 0)),
          tokensOut: Math.max(0, Math.floor(used.tokensOut || 0)),
          costMicros: Math.max(0, Math.floor(used.costMicros || 0)),
          costCurrency: used.costCurrency || null,
        },
        { transaction }
      );
    });
  } catch (err) {
    logger.error(`[ai] job ${jobId} (${job.feature}) failed: ${err.message}`);
    if (err.permanent || lastAttempt) {
      await job.update({ status: 'failed', error: String(err.message || 'Generation failed').slice(0, 500), finishedAt: new Date() });
      // Settled as failed: do not let the queue try again.
      return;
    }
    await job.update({ status: 'queued' });
    throw err;
  }
}

async function getJob(workspaceId, jobId) {
  return jobView(await scoped(db.AiJob, workspaceId, 'AI job').findByPkOrThrow(jobId));
}

async function listJobs(workspaceId, { feature, limit = 20 } = {}) {
  const where = { workspaceId };
  if (feature) where.feature = feature;
  const jobs = await db.AiJob.findAll({ where, order: [['createdAt', 'DESC']], limit });
  return { jobs: jobs.map(jobView) };
}

/**
 * Turns a finished job into a draft. `product` → a draft product (the
 * merchant's edits to the output travel in `overrides`); `page` → an
 * unpublished page on the store's website. Translation and policies have
 * nothing to create: the merchant copies the text where it belongs.
 */
async function applyJob(workspaceId, jobId, { overrides, path: pagePath, target, name, subdomain } = {}, req) {
  const job = await scoped(db.AiJob, workspaceId, 'AI job').findByPkOrThrow(jobId);
  if (job.status !== 'succeeded') throw new AppError('AI_JOB_NOT_READY', 'This generation has no result to apply', 409);
  if (job.applied) throw new AppError('AI_JOB_ALREADY_APPLIED', 'This result was already turned into a draft', 409, job.applied);

  let applied;
  if (job.feature === 'product') {
    const output = validateOutput('product', { ...job.output, ...(overrides || {}) });
    // eslint-disable-next-line global-require
    const { product } = await require('../catalog/catalogService').createProduct(
      workspaceId,
      {
        name: output.name,
        slug: output.slug,
        description: output.description,
        status: 'draft',
        seo: { description: output.metaDescription },
        specialOfferText: output.specialOfferText || null,
        cms: { features: output.features, faqs: output.faqs },
        media: (job.input.imageUrls || []).map((url) => ({ url })),
      },
      req
    );
    applied = { type: 'product', id: product.id };
  } else if (job.feature === 'page' && target === 'funnel') {
    // The page as the sales step of a new draft funnel (applyFunnel.js).
    applied = await require('./applyFunnel').applyAsFunnel(workspaceId, job, { name, subdomain }, req);
  } else if (job.feature === 'page') {
    const website = await db.Website.findOne({ where: { workspaceId }, order: [['updatedAt', 'DESC']] });
    if (!website) throw new AppError('WEBSITE_REQUIRED', 'Create your store website first, then add the page to it', 409);
    // eslint-disable-next-line global-require
    const pages = require('../pages/pagesService');
    const base = pages.normalizePath(pagePath || `landing-${String(job.id).slice(0, 8)}`);
    const page = await pages.createPage(
      workspaceId,
      website.id,
      { path: base, title: job.output.title, pageType: 'custom', draftData: job.output.tree },
      req
    );
    applied = { type: 'page', id: page.id, websiteId: website.id, path: page.path };
  } else {
    throw new AppError('AI_NOTHING_TO_APPLY', 'This kind of result is copied by hand, not applied', 422);
  }

  await job.update({ applied });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'ai.apply',
    entityType: 'AiJob',
    entityId: job.id,
    after: applied,
    req,
  });
  return jobView(job);
}

module.exports = { createJob, runJob, getJob, listJobs, applyJob, usage, PLAN_LIMIT_KEY };
