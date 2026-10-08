'use strict';

const db = require('../../db/models');

/**
 * Which language a WhatsApp template goes out in for one customer (item 383).
 *
 * Meta keeps one template per (name, language). When the customer's order
 * (or checkout) is in a language the store has that template APPROVED in,
 * that language is sent — 'en' matches 'en' first, then any 'en_*' (en_US,
 * en_GB). Otherwise the send keeps what it did before (`fallback`: the
 * automation step's language, the action's default 'ar').
 */
async function languageFor(workspaceId, name, locale, fallback = 'ar') {
  const base = require('../orders/orderLocale').baseOf(locale);
  if (!base || !name) return fallback;
  const rows = await db.WhatsappTemplate.findAll({ where: { workspaceId, name, status: 'APPROVED' }, attributes: ['language'] });
  const langs = rows.map((r) => String(r.language));
  return langs.find((l) => l.toLowerCase() === base) || langs.find((l) => l.toLowerCase().split(/[-_]/)[0] === base) || fallback;
}

/** The language of an automation's subject: its order's, else its checkout's. */
const localeOfSubject = (subject) => (subject && subject.order ? subject.order.locale : subject && subject.session ? subject.session.locale : null) || null;

module.exports = { languageFor, localeOfSubject };
