'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { recordAudit } = require('../audit/auditService');

/**
 * Education (SPEC §18.6 "tutorial video links next to every important
 * setting, a help center, a Telegram channel for updates, support chat";
 * §15.1 "educational cards" on the home page).
 *
 * The links are ZIMOS's, not written in code: the platform team sets them in
 * the console (platform_settings 'education_links'), and the dashboard shows
 * only the ones that are set.
 *
 *   GET /me/education            the merchant's dashboard
 *   GET /admin/education         the console
 *   PUT /admin/education         { helpCenterUrl, telegramUrl, supportChatUrl, tutorials: { <topic>: url } }
 */

const SETTING_KEY = 'education_links';
// The dashboard pages with a "watch the tutorial" link; a new one is added here and on its page.
const TOPICS = ['products', 'shipping', 'payments', 'website', 'funnels', 'offers', 'marketing', 'automations', 'fraud', 'profit'];

const url = Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(500).allow('', null);
const schema = Joi.object({
  helpCenterUrl: url,
  telegramUrl: url,
  supportChatUrl: url,
  tutorials: Joi.object(Object.fromEntries(TOPICS.map((t) => [t, url]))).default({}),
});

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

async function links() {
  const row = await db.PlatformSetting.findByPk(SETTING_KEY);
  const v = (row && row.value) || {};
  const tutorials = {};
  for (const topic of TOPICS) {
    const link = clean(v.tutorials && v.tutorials[topic]);
    if (link) tutorials[topic] = link;
  }
  return { helpCenterUrl: clean(v.helpCenterUrl), telegramUrl: clean(v.telegramUrl), supportChatUrl: clean(v.supportChatUrl), tutorials };
}

const me = Router();
me.get('/', authenticate, asyncHandler(async (req, res) => res.json({ education: await links() })));

const admin = Router();
admin.get('/education', can(P.ANNOUNCEMENTS_VIEW), asyncHandler(async (req, res) => res.json({ education: await links(), topics: TOPICS })));
admin.put(
  '/education',
  can(P.ANNOUNCEMENTS_MANAGE),
  validate({ body: schema }),
  asyncHandler(async (req, res) => {
    const before = await links();
    const value = {
      helpCenterUrl: clean(req.body.helpCenterUrl),
      telegramUrl: clean(req.body.telegramUrl),
      supportChatUrl: clean(req.body.supportChatUrl),
      tutorials: Object.fromEntries(TOPICS.map((t) => [t, clean(req.body.tutorials[t])]).filter(([, v]) => v)),
    };
    const [row] = await db.PlatformSetting.findOrCreate({ where: { key: SETTING_KEY }, defaults: { key: SETTING_KEY, value: {} } });
    await row.update({ value, updatedBy: req.user.id });
    const after = await links();
    await recordAudit({ actorUserId: req.user.id, action: 'platform.education_links_update', entityType: 'PlatformSetting', entityId: SETTING_KEY, before, after, req });
    res.json({ education: after, topics: TOPICS });
  })
);

module.exports = { TOPICS, links, me, admin };
