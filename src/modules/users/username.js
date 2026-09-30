'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const { isReservedUsername } = require('./reservedUsernames');

/**
 * Usernames (users.username, migration 124): a public handle next to the
 * email, unique regardless of case and always stored lower-case.
 *
 * Rules: 3–30 characters of a–z, 0–9, "_" and "."; starts with a letter; no
 * two dots in a row; does not end with "_" or "."; not on the reserved list
 * (reservedUsernames.js). Uniqueness is the partial unique index on
 * lower(username); callers turn its violation into 409 USERNAME_TAKEN.
 */

const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const USERNAME_PATTERN = /^[a-z][a-z0-9._]{1,28}[a-z0-9]$/;
// How often a username may be changed after it is first set.
const CHANGE_INTERVAL_DAYS = 30;

/** The stored form of what someone typed. */
const normalizeUsername = (value) => String(value || '').trim().toLowerCase();

/** 'invalid' | 'reserved' | null for an already-normalised value. */
function usernameProblem(username) {
  if (typeof username !== 'string' || username.length < USERNAME_MIN || username.length > USERNAME_MAX) return 'invalid';
  if (!USERNAME_PATTERN.test(username) || username.includes('..')) return 'invalid';
  if (isReservedUsername(username)) return 'reserved';
  return null;
}

const REASON_MESSAGES = Object.freeze({
  invalid:
    'Use 3–30 lowercase English letters, numbers, "_" or ".", starting with a letter, with no ".." and not ending in "_" or "."',
  reserved: 'That username is reserved',
  taken: 'That username is already taken',
});

/** Joi rule for a username in a request body (lower-cased first, then judged). */
const usernameSchema = Joi.string()
  .trim()
  .lowercase()
  .min(USERNAME_MIN)
  .max(USERNAME_MAX)
  .custom((value, helpers) => {
    const problem = usernameProblem(value);
    if (problem === 'invalid') return helpers.error('username.invalid');
    if (problem === 'reserved') return helpers.error('username.reserved');
    return value;
  })
  .messages({ 'username.invalid': REASON_MESSAGES.invalid, 'username.reserved': REASON_MESSAGES.reserved });

/**
 * A valid starting point from an email's local part (or any text): lower-case,
 * only allowed characters, starting with a letter, no "..", not ending in
 * "_"/".", padded to the minimum and cut to leave room for a suffix. Not
 * checked for reserved names or availability — see candidates().
 */
function usernameBase(source, maxLength = USERNAME_MAX - 5) {
  let base = normalizeUsername(source)
    .split('@')[0]
    .replace(/-/g, '_')
    .replace(/[^a-z0-9._]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z]+/, '');
  base = base.slice(0, maxLength).replace(/[._]+$/, '');
  if (base.length < USERNAME_MIN) base = `${base}user`.replace(/^[^a-z]+/, '') || 'user';
  if (base.length < USERNAME_MIN) base = 'user';
  return base;
}

/** A short random numeric suffix ("_4821"). */
const randomSuffix = () => `_${crypto.randomInt(1000, 10000)}`;

/**
 * Candidates for someone with this email, best first: the cleaned local part,
 * then the same with random suffixes. Reserved ones are skipped.
 */
function* candidates(source, tries = 12) {
  const base = usernameBase(source);
  if (!usernameProblem(base)) yield base;
  for (let i = 0; i < tries; i += 1) {
    const candidate = `${base}${randomSuffix()}`.slice(0, USERNAME_MAX);
    if (!usernameProblem(candidate)) yield candidate;
  }
}

/** Is this Sequelize/pg error the username unique index? */
function isUsernameConflict(err) {
  const constraint = (err && err.parent && err.parent.constraint) || (err && err.original && err.original.constraint) || '';
  return (
    (err && err.name === 'SequelizeUniqueConstraintError' && /username/i.test(`${constraint} ${JSON.stringify(err.fields || {})}`)) ||
    /users_username_lower_unique/.test(constraint)
  );
}

module.exports = {
  USERNAME_MIN,
  USERNAME_MAX,
  CHANGE_INTERVAL_DAYS,
  REASON_MESSAGES,
  normalizeUsername,
  usernameProblem,
  usernameSchema,
  usernameBase,
  candidates,
  isUsernameConflict,
};
