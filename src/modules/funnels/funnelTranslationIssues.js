'use strict';

const db = require('../../db/models');

/**
 * The funnel issues' "untranslated text" (SPEC §9.2 Quality, §9.7 Languages):
 * the store sells in more than one language (Store settings → Languages) and
 * a step has texts with no translation in one of them — a shopper browsing in
 * that language would read the original. One warning per step and language,
 * with how many texts are missing. Texts are counted the way the Languages
 * screen translates them (translations/contentTranslations.js: one entry per
 * distinct sentence, keyed by its hash), on the step as it is now.
 */
async function untranslatedIssues(workspace, funnelId, steps) {
  const { languagesOf } = require('../translations/translations');
  const { textsOf } = require('../translations/contentTranslations');
  const { defaultLocale, languages } = languagesOf(workspace);
  const others = languages.filter((l) => l !== defaultLocale);
  if (others.length === 0) return [];

  const perStep = steps.map((step) => ({ step, keys: [...textsOf(step.builderData).keys()] })).filter((s) => s.keys.length > 0);
  if (perStep.length === 0) return [];
  const allKeys = [...new Set(perStep.flatMap((s) => s.keys))];
  const rows = await db.Translation.findAll({
    where: { workspaceId: workspace.id, entityType: 'funnel', entityId: funnelId, locale: others, field: allKeys },
    attributes: ['locale', 'field', 'value'],
  });
  const done = new Set(rows.filter((r) => typeof r.value === 'string' && r.value.trim()).map((r) => `${r.locale}:${r.field}`));

  const issues = [];
  for (const { step, keys } of perStep) {
    for (const locale of others) {
      const missing = keys.filter((k) => !done.has(`${locale}:${k}`)).length;
      if (missing === 0) continue;
      issues.push({
        severity: 'warning',
        code: 'untranslated_text',
        stepKey: step.key,
        elementId: null,
        locale,
        count: missing,
        message: `${missing} text(s) on "${step.name}" are not translated into ${locale} (Store settings → Languages)`,
      });
    }
  }
  return issues;
}

module.exports = { untranslatedIssues };
