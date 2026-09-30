'use strict';

const db = require('../../db/models');
const { AppError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const {
  CHANGE_INTERVAL_DAYS,
  REASON_MESSAGES,
  candidates,
  isUsernameConflict,
  normalizeUsername,
  usernameProblem,
} = require('./username');

const DAY_MS = 24 * 60 * 60 * 1000;

const takenError = () => new ConflictError(REASON_MESSAGES.taken, 'USERNAME_TAKEN');

/** Whether another account holds this (normalised) username. */
async function isTaken(username, { exceptUserId = null, transaction } = {}) {
  const row = await db.User.findOne({
    where: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('username')), username),
    attributes: ['id'],
    transaction,
  });
  return Boolean(row && row.id !== exceptUserId);
}

/**
 * GET /auth/username-available: { available } or { available: false, reason }
 * with reason 'invalid' | 'reserved' | 'taken'. Says nothing about who holds it.
 */
async function availability(raw) {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) return { available: false, reason: problem };
  if (await isTaken(username)) return { available: false, reason: 'taken' };
  return { available: true };
}

/** The first free candidate for this email (see username.candidates). */
async function suggestFor(email, { transaction } = {}) {
  for (const candidate of candidates(email, 20)) {
    if (!(await isTaken(candidate, { transaction }))) return candidate;
  }
  // Twenty random suffixes all taken is not a real case; fall back to a long one.
  return `user_${Date.now().toString(36)}`.slice(0, 30);
}

/**
 * Sets the signed-in user's username. The first choice (an account made
 * through Google has none yet) is free; after that, one change per
 * CHANGE_INTERVAL_DAYS. The old name is released at once. 409 USERNAME_TAKEN
 * when someone else has it — including when they took it a moment ago
 * (the unique index decides).
 */
async function changeUsername(userId, raw, req) {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) throw new ValidationError([{ field: 'username', message: REASON_MESSAGES[problem] }], REASON_MESSAGES[problem]);

  return db.sequelize.transaction(async (transaction) => {
    const user = await db.User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (user.username === username) return user;

    const firstChoice = !user.username;
    if (!firstChoice && user.usernameChangedAt) {
      const next = new Date(new Date(user.usernameChangedAt).getTime() + CHANGE_INTERVAL_DAYS * DAY_MS);
      if (next > new Date()) {
        throw new AppError('USERNAME_CHANGE_TOO_SOON', `A username can be changed once every ${CHANGE_INTERVAL_DAYS} days`, 409, {
          nextChangeAt: next.toISOString(),
        });
      }
    }
    if (await isTaken(username, { exceptUserId: user.id, transaction })) throw takenError();

    const before = user.username;
    try {
      await user.update({ username, usernameChangedAt: firstChoice ? user.usernameChangedAt : new Date() }, { transaction });
    } catch (err) {
      if (isUsernameConflict(err)) throw takenError();
      throw err;
    }
    await recordAudit({
      actorUserId: user.id,
      action: firstChoice ? 'user.username.set' : 'user.username.change',
      entityType: 'User',
      entityId: user.id,
      before: { username: before },
      after: { username },
      req,
      transaction,
    });
    return user;
  });
}

module.exports = { isTaken, availability, suggestFor, changeUsername, takenError };
