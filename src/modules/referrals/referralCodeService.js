'use strict';

const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { applyBasisPoints } = require('../../core/utils/money');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES } = require('../../core/security/platformPermissions');
const { commissionRateFor } = require('./commissionPolicy');

/**
 * Agent referral codes (migration 106). Only platform users with
 * agents.manage create or change them (the routes check that); an agent can
 * read their own and nothing more.
 *
 * A code is stored uppercase and matched uppercase, so a merchant can type it
 * in any case. The code string never changes once created — merchants and
 * printed material use it — so a new area gets a new code. Deactivating a
 * code stops it being entered and stops it discounting or earning on any
 * charge paid from then on, including one already priced with it (the charge
 * service re-checks the code at payment); it stays attached to the
 * subscriptions that used it.
 */

const DISCOUNT_TYPES = ['none', 'percentage', 'fixed'];
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function serializeCode(code) {
  return {
    id: code.id,
    agentId: code.agentId,
    code: code.code,
    label: code.label,
    discountType: code.discountType,
    // BIGINT arrives from pg as a string — hand the client a number.
    discountValue: code.discountValue == null ? null : Number(code.discountValue),
    discountCurrency: code.discountCurrency,
    // The override as stored (null = platform default) and the rate in force.
    commissionRateBp: code.commissionRateBp,
    effectiveCommissionRateBp: commissionRateFor(code),
    active: code.active,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
  };
}

/** What a merchant sees of a code: the discount, never the agent or label. */
function serializeCodeForMerchant(code) {
  return {
    code: code.code,
    discountType: code.discountType,
    discountValue: code.discountValue == null ? null : Number(code.discountValue),
    discountCurrency: code.discountCurrency,
    active: code.active,
  };
}

/**
 * The discount fields must agree with each other; the same rule as the
 * referral_codes_discount_check constraint, reported field by field.
 */
function assertDiscount({ discountType, discountValue, discountCurrency }) {
  const errors = [];
  if (!DISCOUNT_TYPES.includes(discountType)) {
    errors.push({ field: 'discountType', message: `discountType must be one of ${DISCOUNT_TYPES.join(', ')}` });
  } else if (discountType === 'none') {
    if (discountValue != null) errors.push({ field: 'discountValue', message: 'A code with no discount takes no discountValue' });
    if (discountCurrency != null) errors.push({ field: 'discountCurrency', message: 'A code with no discount takes no discountCurrency' });
  } else if (discountValue == null) {
    errors.push({ field: 'discountValue', message: `A ${discountType} discount needs a discountValue` });
  } else if (discountType === 'percentage') {
    if (!Number.isInteger(discountValue) || discountValue < 1 || discountValue > 10000) {
      errors.push({ field: 'discountValue', message: 'A percentage is in basis points, from 1 (0.01%) to 10000 (100%)' });
    }
    if (discountCurrency != null) errors.push({ field: 'discountCurrency', message: 'A percentage discount takes no currency' });
  } else {
    if (!Number.isInteger(discountValue) || discountValue < 1) {
      errors.push({ field: 'discountValue', message: 'A fixed discount is a positive amount in minor units' });
    }
    if (!/^[A-Z]{3}$/.test(discountCurrency || '')) {
      errors.push({ field: 'discountCurrency', message: 'A fixed discount needs a 3-letter currency code' });
    }
  }
  if (errors.length) throw new ValidationError(errors, 'Invalid body');
}

/**
 * The discount a code takes off a charge of `grossAmount` in `currency`:
 * never more than the charge itself, and nothing for a fixed amount in a
 * different currency (amounts are never converted). Integer minor units.
 */
function discountFor(code, grossAmount, currency) {
  const gross = Number(grossAmount);
  if (!code || !code.active || gross <= 0) return 0;
  const value = code.discountValue == null ? 0 : Number(code.discountValue);
  let discount = 0;
  if (code.discountType === 'percentage') discount = applyBasisPoints(gross, value);
  else if (code.discountType === 'fixed' && code.discountCurrency === currency) discount = value;
  return Math.max(0, Math.min(discount, gross));
}

async function auditCode(action, req, code, before, after, transaction) {
  await recordAudit({
    actorUserId: req.user.id,
    action,
    entityType: 'ReferralCode',
    entityId: code.id,
    before,
    after,
    metadata: { code: code.code, agentId: code.agentId },
    req,
    transaction,
  });
}

function auditState(code) {
  const { id, createdAt, updatedAt, effectiveCommissionRateBp, ...rest } = serializeCode(code);
  return rest;
}

async function createCodeInTransaction(agentId, body, req, transaction) {
  const agent = await db.User.findByPk(agentId, { attributes: ['id', 'platformRole'], transaction });
  if (!agent) throw new NotFoundError('Agent');
  if (agent.platformRole !== PLATFORM_ROLES.AGENT) {
    throw new ConflictError('Referral codes can only be given to an account with the agent role.', 'NOT_AN_AGENT');
  }

  const code = normalizeCode(body.code);
  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError(
      [{ field: 'code', message: 'A code is 3 to 32 letters, digits or dashes, starting with a letter or digit' }],
      'Invalid body'
    );
  }
  const fields = {
    discountType: body.discountType || 'none',
    discountValue: body.discountValue == null ? null : body.discountValue,
    discountCurrency: body.discountCurrency == null ? null : body.discountCurrency,
  };
  assertDiscount(fields);

  if (await db.ReferralCode.findOne({ where: { code }, attributes: ['id'], transaction })) {
    throw new ConflictError(`The code ${code} is already taken.`, 'REFERRAL_CODE_TAKEN');
  }

  const created = await db.ReferralCode.create(
    {
      agentId,
      code,
      label: body.label ? body.label : null,
      ...fields,
      commissionRateBp: body.commissionRateBp == null ? null : body.commissionRateBp,
      active: body.active === undefined ? true : body.active,
      createdByUserId: req.user.id,
    },
    { transaction }
  );
  await auditCode('referral_code.create', req, created, null, auditState(created), transaction);
  return created;
}

async function createCode(agentId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    try {
      return serializeCode(await createCodeInTransaction(agentId, body, req, transaction));
    } catch (err) {
      throw uniqueViolationToConflict(err, body.code);
    }
  });
}

// Two admins creating the same code at once both pass the pre-check; the
// unique index catches the loser, which should get the same 409.
function uniqueViolationToConflict(err, code) {
  if (err && err.name === 'SequelizeUniqueConstraintError') {
    return new ConflictError(`The code ${normalizeCode(code)} is already taken.`, 'REFERRAL_CODE_TAKEN');
  }
  return err;
}

const EDITABLE = ['label', 'discountType', 'discountValue', 'discountCurrency', 'commissionRateBp', 'active'];

async function updateCode(codeId, patch, req) {
  return db.sequelize.transaction(async (transaction) => {
    const code = await db.ReferralCode.findByPk(codeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!code) throw new NotFoundError('Referral code');

    const next = {};
    for (const key of EDITABLE) if (key in patch) next[key] = patch[key] === '' ? null : patch[key];
    // Switching the type clears the fields the new type does not take, so a
    // form can send just { discountType: 'none' }.
    if (next.discountType === 'none') {
      if (!('discountValue' in next)) next.discountValue = null;
      if (!('discountCurrency' in next)) next.discountCurrency = null;
    } else if (next.discountType === 'percentage' && !('discountCurrency' in next)) {
      next.discountCurrency = null;
    }
    const merged = {
      discountType: 'discountType' in next ? next.discountType : code.discountType,
      discountValue:
        'discountValue' in next ? next.discountValue : code.discountValue == null ? null : Number(code.discountValue),
      discountCurrency: 'discountCurrency' in next ? next.discountCurrency : code.discountCurrency,
    };
    assertDiscount(merged);

    const before = auditState(code);
    await code.update(next, { transaction });
    await auditCode('referral_code.update', req, code, before, auditState(code), transaction);
    return serializeCode(code);
  });
}

/**
 * The active code a merchant typed, or a 422 that says nothing about whether
 * an inactive code by that name exists.
 */
async function findUsableCode(input, transaction) {
  const code = normalizeCode(input);
  const row = CODE_PATTERN.test(code) ? await db.ReferralCode.findOne({ where: { code }, transaction }) : null;
  if (!row || !row.active) {
    throw new AppError('REFERRAL_CODE_INVALID', "That referral code isn't valid. Check it and try again.", 422);
  }
  return row;
}

module.exports = {
  DISCOUNT_TYPES,
  CODE_PATTERN,
  normalizeCode,
  serializeCode,
  serializeCodeForMerchant,
  assertDiscount,
  discountFor,
  createCode,
  createCodeInTransaction,
  uniqueViolationToConflict,
  updateCode,
  findUsableCode,
};
