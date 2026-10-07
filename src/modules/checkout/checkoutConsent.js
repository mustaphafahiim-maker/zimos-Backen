'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/*
 * The checkout's two consent boxes (item 374, Lightfunnels parity), set in
 * settings.checkout_settings beside the purchase form (checkoutForm.js):
 *
 *   marketing_checkbox        'off' (default) | 'on'
 *     An unticked "email me news and offers" box. Ticked
 *     (`acceptsMarketing: true`), the order's customer gets marketing
 *     consent, so the email-marketing sync (emailMarketing/) and the
 *     store's other marketing channels take them, as a newsletter sign-up
 *     does. An earlier STOP reply or unsubscribe (marketing_opt_outs, by
 *     phone or email) is kept: the box does not lift it (as contact
 *     import, item 315). Unticked changes nothing: a buyer who agreed
 *     before keeps their consent. Never pre-ticked by the server.
 *
 *   terms_checkbox            'off' (default) | 'required'
 *     "I agree to the terms". 'required' refuses a checkout without
 *     `acceptsTerms: true` (422, field acceptsTerms). The storefront links
 *     the store's terms of service and privacy policy (the ones written).
 *
 *   marketing_checkbox_label / terms_checkbox_label  { ar, en }, optional;
 *     empty = the storefront's built-in wording.
 *
 * What the shopper agreed to is kept on the order (orders.consents,
 * migration 509; not inside attribution, whose `consent` is the cookie
 * banner's answer — marketing/cookieConsent.js):
 *   { marketing: { accepted, applied, reason?, at, label },
 *     terms: { accepted, at, label, policies, version } }
 * `version` is a short hash of the linked policies' text at that moment,
 * so the merchant can tell which wording a buyer agreed to.
 * A box the store does not show is ignored when sent anyway, and not kept.
 */

const MARKETING_MODES = ['off', 'on'];
const TERMS_MODES = ['off', 'required'];
const TERMS_POLICIES = ['terms_of_service', 'privacy_policy'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const cleanLabel = (v) => ({ ar: text(v && v.ar), en: text(v && v.en) });

/** Joi keys of settings.checkout_settings (spread into checkoutForm.checkoutFormSettingsKeys). */
function settingsKeys(Joi) {
  const label = Joi.object({
    ar: Joi.string().trim().max(300).allow('', null).optional(),
    en: Joi.string().trim().max(300).allow('', null).optional(),
  });
  return {
    marketing_checkbox: Joi.string().valid(...MARKETING_MODES).allow(null).optional(),
    marketing_checkbox_label: label.allow(null).optional(),
    terms_checkbox: Joi.string().valid(...TERMS_MODES).allow(null).optional(),
    terms_checkbox_label: label.allow(null).optional(),
  };
}

/** Joi keys of the checkout body. */
function bodyKeys(Joi) {
  return {
    acceptsMarketing: Joi.boolean().optional(),
    acceptsTerms: Joi.boolean().optional(),
  };
}

/** The store's two boxes as the storefront renders them (GET /store/:ws → checkout.consent). */
function resolveConsent(workspace) {
  const settings = (workspace && workspace.settings) || {};
  const s = settings.checkout_settings || {};
  const legal = settings.legal || {};
  return {
    marketing: { enabled: s.marketing_checkbox === 'on', label: cleanLabel(s.marketing_checkbox_label) },
    terms: {
      enabled: s.terms_checkbox === 'required',
      required: s.terms_checkbox === 'required',
      label: cleanLabel(s.terms_checkbox_label),
      // Each served at GET /store/:ws/policies/:key.
      policies: TERMS_POLICIES.filter((key) => text(legal[key]) !== ''),
    },
  };
}

/** The 422 problems of a checkout that skips a required box (added to assertCheckoutForm's). */
function problems(consent, body) {
  if (consent.terms.required && body.acceptsTerms !== true) {
    return [{ field: 'acceptsTerms', message: '"acceptsTerms" must be [true]' }];
  }
  return [];
}

function policiesVersion(workspace, keys) {
  const legal = (workspace.settings && workspace.settings.legal) || {};
  if (!keys.length) return null;
  const hash = crypto.createHash('sha256');
  for (const key of keys) hash.update(`${key}\n${text(legal[key])}\n`);
  return hash.digest('hex').slice(0, 16);
}

async function optedOut(workspaceId, customer, contactEmail) {
  const { Op } = db.Sequelize;
  const emails = [...new Set([contactEmail, customer.email].filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
  const or = [{ phoneNormalized: customer.phoneNormalized }];
  if (emails.length) or.push({ email: emails });
  return (await db.MarketingOptOut.count({ where: { workspaceId, [Op.or]: or } })) > 0;
}

/**
 * After the order exists: keeps the answers on it and gives the customer
 * marketing consent when they ticked the box. Never throws — the order stands.
 */
async function recordOnOrder(order, workspace, { acceptsMarketing, acceptsTerms } = {}) {
  try {
    const consent = resolveConsent(workspace);
    if (!consent.marketing.enabled && !consent.terms.enabled) return;
    const at = new Date().toISOString();
    const consents = {};

    if (consent.terms.enabled) {
      consents.terms = {
        accepted: acceptsTerms === true,
        at,
        label: consent.terms.label,
        policies: consent.terms.policies,
        version: policiesVersion(workspace, consent.terms.policies),
      };
    }

    if (consent.marketing.enabled) {
      const entry = { accepted: acceptsMarketing === true, applied: false, at, label: consent.marketing.label };
      const customer = entry.accepted && order.customerId ? await db.Customer.findOne({ where: { id: order.customerId, workspaceId: order.workspaceId } }) : null;
      if (customer) {
        const contactEmail = order.contactSnapshot && order.contactSnapshot.email;
        if (await optedOut(order.workspaceId, customer, contactEmail)) {
          entry.reason = 'opted_out';
        } else {
          // An instance update, so contact.updated fires and the email-marketing sync pushes the contact.
          if (!customer.marketingConsent) await customer.update({ marketingConsent: true });
          entry.applied = true;
        }
      }
      consents.marketing = entry;
    }

    await order.update({ consents });
  } catch (err) {
    logger.warn('Could not record the checkout consent', { orderId: order && order.id, error: err.message });
  }
}

module.exports = { MARKETING_MODES, TERMS_MODES, settingsKeys, bodyKeys, resolveConsent, problems, recordOnOrder };
