'use strict';

const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const logger = require('../../core/utils/logger');
const botProtection = require('../risk/botProtection');

/**
 * The checkout autosave behind the same bot guard as the order (SPEC §5.1):
 * a filled honeypot, or no valid time token, or one issued less than
 * MIN_SECONDS ago, and nothing is stored. Without this a script could fill
 * Lost orders with invented names and numbers for the team to call.
 *
 * The autosave runs while the shopper types, so it carries no challenge
 * token (that one is spent on the order) and a refusal is quiet: the answer
 * looks like a saved session, with an id that names nothing. The order path
 * treats an unknown session id as no session. The storefront waits out a
 * fresh token before it saves (lib/botGuard.ts), so a real shopper is never
 * caught by the timing check.
 *
 * Runs after validation; the guard's fields are taken off the body either way.
 */

function failedCheck(body, workspaceId) {
  const honeypot = body[botProtection.HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') return 'honeypot';
  const age = botProtection.tokenAge(body.botToken, workspaceId);
  if (age === null || age > botProtection.MAX_AGE_MS) return 'token';
  if (age < botProtection.MIN_SECONDS * 1000) return 'too_fast';
  return null;
}

const guardAutosave = asyncHandler(async (req, res, next) => {
  const body = req.body || {};
  const workspace = req.publicWorkspace;
  const check = botProtection.settingsOf(workspace).enabled ? failedCheck(body, workspace.id) : null;
  delete body[botProtection.HONEYPOT_FIELD];
  delete body.botToken;
  if (!check) return next();
  logger.info(`[checkout-sessions] autosave refused by the bot guard (${check})`, { workspaceId: workspace.id });
  return res.json({ session: { id: crypto.randomUUID() } });
});

module.exports = { guardAutosave, failedCheck };
