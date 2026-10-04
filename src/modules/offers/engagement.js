'use strict';

const Joi = require('joi');
const db = require('../../db/models');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');

/*
 * SPEC §10.7–10.9:
 *
 *   social proof   "Ahmed from Mansoura bought X 12 minutes ago" — only from
 *                  real orders of the last seven days that were confirmed or
 *                  went further, first name and governorate only. With fewer
 *                  than MIN_REAL_ORDERS such orders nothing is shown at all:
 *                  there is no fallback, no invented names (SPEC §21).
 *   newsletter     a sign-up form (footer or popup) that creates a contact
 *                  with marketing consent, optionally in exchange for one of
 *                  the store's coupons.
 *   referrals      what each `?ref=CODE` link brought in, read off the
 *                  attribution the storefront records on orders.
 *
 * The two settings live in workspaces.settings (snake_case keys, like the
 * rest) and are written through their own PUT, whole.
 */

const SOCIAL_KEY = 'social_proof';
const NEWSLETTER_KEY = 'newsletter';
const MIN_REAL_ORDERS = 3;
const SOCIAL_WINDOW_DAYS = 7;
const SOCIAL_MAX_ITEMS = 20;
const CACHE_MS = 60 * 1000;

const text = (max) => Joi.string().trim().max(max).allow('', null);

const schemas = {
  socialProof: Joi.object({
    enabled: Joi.boolean().required(),
    position: Joi.string().valid('bottom_start', 'bottom_end').default('bottom_start'),
    delaySeconds: Joi.number().integer().min(1).max(120).default(8),
    intervalSeconds: Joi.number().integer().min(5).max(300).default(20),
    maxPerSession: Joi.number().integer().min(1).max(20).default(5),
    pages: Joi.string().valid('all', 'product').default('all'),
    showName: Joi.boolean().default(true),
    showCity: Joi.boolean().default(true),
  }),
  newsletter: Joi.object({
    enabled: Joi.boolean().required(),
    placement: Joi.string().valid('footer', 'popup').default('footer'),
    delaySeconds: Joi.number().integer().min(3).max(600).default(20),
    title: text(120),
    text: text(300),
    askName: Joi.boolean().default(true),
    askEmail: Joi.boolean().default(false),
    discountId: Joi.string().uuid().allow(null).default(null),
  }),
  subscribe: Joi.object({
    fullName: text(200),
    phone: Joi.string().trim().min(6).max(32).required(),
    email: Joi.string().trim().email().max(255).allow('', null),
    // A honeypot: people never see it, bots fill it in.
    website: Joi.string().max(500).allow('', null),
  }),
};

function read(settings, key, schema) {
  const stored = settings && typeof settings === 'object' ? settings[key] : null;
  const { value, error } = schema.validate(stored || { enabled: false }, { stripUnknown: true });
  return error ? schema.validate({ enabled: false }).value : value;
}

async function getSetting(workspaceId, key, schema) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return read(workspace.settings, key, schema);
}

async function saveSetting(workspaceId, key, schema, data, action, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = read(workspace.settings, key, schema);
    workspace.settings = { ...(workspace.settings || {}), [key]: data };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType: 'Workspace', entityId: workspaceId, before, after: data, req, transaction });
    return data;
  });
}

// ------------------------------------------------------------ social proof --

const socialCache = new Map(); // workspaceId → { at, items }

/** The first word of a name, when it reads like a name (no digits, not a phone). */
function firstName(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  return first.length >= 2 && first.length <= 20 && !/\d/.test(first) ? first : null;
}

/** Recent real purchases, newest first: confirmed orders of the last seven days, one line each. */
async function recentPurchases(workspaceId) {
  const cached = socialCache.get(workspaceId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
  const rows = await db.sequelize.query(
    `SELECT o.id, o.created_at AS "createdAt", o.contact_snapshot AS contact, o.shipping_address_snapshot AS address,
            p.id AS "productId", p.name AS "productName", p.slug AS "productSlug", p.media
       FROM orders o
       JOIN LATERAL (
              SELECT oi.product_id FROM order_items oi
               WHERE oi.order_id = o.id AND oi.product_id IS NOT NULL AND NOT oi.is_order_bump
               ORDER BY oi.line_total_amount DESC LIMIT 1
            ) top ON true
       JOIN products p ON p.id = top.product_id AND p.status = 'active'
                      AND COALESCE((p.page_settings ->> 'hidden')::boolean, false) = false
      WHERE o.workspace_id = :workspaceId
        AND o.created_at > NOW() - INTERVAL '${SOCIAL_WINDOW_DAYS} days'
        AND o.cancelled_at IS NULL
        AND o.confirmation_state = 'confirmed'
        AND COALESCE(o.is_test, false) = false
      ORDER BY o.created_at DESC
      LIMIT ${SOCIAL_MAX_ITEMS}`,
    { replacements: { workspaceId }, type: db.Sequelize.QueryTypes.SELECT }
  );
  const items = rows.map((row) => {
    const media = Array.isArray(row.media) ? row.media.find((m) => m && typeof m.url === 'string' && m.url) : null;
    return {
      firstName: firstName(row.contact && row.contact.fullName),
      city: (row.address && (row.address.province || row.address.city)) || null,
      productName: row.productName,
      productSlug: row.productSlug,
      imageUrl: media ? media.url : null,
      at: row.createdAt,
    };
  });
  socialCache.set(workspaceId, { at: Date.now(), items });
  return items;
}

/** GET /store/:id/social-proof — null unless switched on and there are enough real orders to show. */
async function publicSocialProof(workspace) {
  const config = read(workspace.settings, SOCIAL_KEY, schemas.socialProof);
  if (!config.enabled) return null;
  const purchases = await recentPurchases(workspace.id);
  if (purchases.length < MIN_REAL_ORDERS) return null;
  return {
    position: config.position,
    delaySeconds: config.delaySeconds,
    intervalSeconds: config.intervalSeconds,
    maxPerSession: config.maxPerSession,
    pages: config.pages,
    items: purchases.map((p) => ({
      firstName: config.showName ? p.firstName : null,
      city: config.showCity ? p.city : null,
      productName: p.productName,
      productSlug: p.productSlug,
      imageUrl: p.imageUrl,
      at: p.at,
    })),
  };
}

/** For the dashboard: the setting, and how many real orders there are to show right now. */
async function getSocialProof(workspaceId) {
  socialCache.delete(workspaceId);
  return {
    socialProof: await getSetting(workspaceId, SOCIAL_KEY, schemas.socialProof),
    realOrders: (await recentPurchases(workspaceId)).length,
    minimumOrders: MIN_REAL_ORDERS,
  };
}

// --------------------------------------------------------------- newsletter --

async function usableCoupon(workspaceId, discountId) {
  if (!discountId) return null;
  const now = new Date();
  const discount = await db.Discount.findOne({ where: { id: discountId, workspaceId, status: 'active' } });
  const live =
    discount &&
    discount.code &&
    (!discount.startsAt || discount.startsAt <= now) &&
    (!discount.endsAt || discount.endsAt > now) &&
    (discount.usageLimit === null || discount.usageCount < discount.usageLimit);
  return live ? discount.code : null;
}

async function saveNewsletter(workspaceId, body, req) {
  const data = { ...body, title: body.title || null, text: body.text || null };
  if (data.discountId) {
    const discount = await db.Discount.findOne({ where: { id: data.discountId, workspaceId } });
    if (!discount || !discount.code) throw new ValidationError([{ field: 'discountId', message: 'Choose a discount that has a code' }]);
  }
  return saveSetting(workspaceId, NEWSLETTER_KEY, schemas.newsletter, data, 'newsletter.update', req);
}

/** GET /store/:id/newsletter — what the form shows; whether a coupon is promised, never the code itself. */
async function publicNewsletter(workspace) {
  const config = read(workspace.settings, NEWSLETTER_KEY, schemas.newsletter);
  if (!config.enabled) return null;
  return {
    placement: config.placement,
    delaySeconds: config.delaySeconds,
    title: config.title,
    text: config.text,
    askName: config.askName,
    askEmail: config.askEmail,
    hasCoupon: Boolean(await usableCoupon(workspace.id, config.discountId)),
  };
}

/**
 * POST /store/:id/newsletter/subscribe — the shopper asked to hear from the
 * store: a contact with marketing consent, tagged "newsletter". Someone the
 * store already knows keeps their record and gains the consent. Answers with
 * the coupon when the form promises one.
 */
async function subscribe(workspace, body) {
  const config = read(workspace.settings, NEWSLETTER_KEY, schemas.newsletter);
  if (!config.enabled) throw new AppError('NEWSLETTER_OFF', 'This store has no sign-up form', 404);
  const couponCode = await usableCoupon(workspace.id, config.discountId);
  // A bot's submission is answered like a real one and stored nowhere.
  if (body.website) return { subscribed: true, couponCode: null };

  const phoneNormalized = normalizePhone(body.phone);
  if (!phoneNormalized) throw new ValidationError([{ field: 'phone', message: 'Enter a valid mobile number' }]);
  const fullName = body.fullName || null;
  const email = body.email || null;

  // A new subscriber is a new lead: the plan's monthly leads limit (billing/limitGuards.js).
  await require('../billing/limitGuards').assertLeadRoom(workspace.id, phoneNormalized);
  const existing = await db.Customer.findOne({ where: { workspaceId: workspace.id, phoneNormalized } });
  if (existing) {
    await existing.update({
      marketingConsent: true,
      fullName: existing.fullName || fullName,
      email: existing.email || email,
      tags: [...new Set([...(existing.tags || []), 'newsletter'])],
    });
  } else {
    const lead = await db.Customer.create({
      workspaceId: workspace.id,
      phoneNormalized,
      phoneRaw: body.phone,
      fullName,
      email,
      marketingConsent: true,
      tags: ['newsletter'],
      source: 'newsletter',
    });
    // A new lead (automations, webhooks).
    await require('../../core/outbox/outbox').record(null, 'lead.created', { workspaceId: workspace.id, customerId: lead.id, source: 'newsletter' });
  }
  // Signing up again is opting back in to marketing after an earlier STOP (whatsapp/optOut.js).
  await db.MarketingOptOut.destroy({ where: { workspaceId: workspace.id, phoneNormalized } });
  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: null,
    action: 'newsletter.subscribe',
    entityType: 'Customer',
    after: { phoneNormalized, existing: Boolean(existing) },
  });
  return { subscribed: true, couponCode };
}

// ---------------------------------------------------------------- referrals --

/** Orders and revenue per `?ref=` code over the last `days`, by the order's last touch (else its first). */
async function referralStats(workspaceId, days = 30) {
  const rows = await db.sequelize.query(
    `SELECT lower(COALESCE(NULLIF(o.attribution -> 'last' ->> 'ref', ''), o.attribution -> 'first' ->> 'ref')) AS ref,
            COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE o.confirmation_state = 'confirmed')::int AS "confirmedOrders",
            COALESCE(SUM(o.total_amount), 0)::bigint AS revenue,
            MAX(o.created_at) AS "lastOrderAt"
       FROM orders o
      WHERE o.workspace_id = :workspaceId
        AND o.cancelled_at IS NULL
        AND o.created_at > NOW() - make_interval(days => :days)
        AND COALESCE(NULLIF(o.attribution -> 'last' ->> 'ref', ''), o.attribution -> 'first' ->> 'ref') IS NOT NULL
      GROUP BY 1
      ORDER BY revenue DESC, orders DESC
      LIMIT 200`,
    { replacements: { workspaceId, days }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return rows.map((row) => ({ ...row, revenue: Number(row.revenue) }));
}

module.exports = {
  MIN_REAL_ORDERS,
  schemas,
  getSocialProof,
  saveSocialProof: (workspaceId, data, req) => {
    socialCache.delete(workspaceId);
    return saveSetting(workspaceId, SOCIAL_KEY, schemas.socialProof, data, 'social_proof.update', req);
  },
  publicSocialProof,
  getNewsletter: (workspaceId) => getSetting(workspaceId, NEWSLETTER_KEY, schemas.newsletter),
  saveNewsletter,
  publicNewsletter,
  subscribe,
  referralStats,
};
