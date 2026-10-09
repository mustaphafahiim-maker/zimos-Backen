'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

/**
 * The OAuth `state` of a Google sign-in. GET /auth/google makes a random
 * value, keeps it in a short httpOnly cookie on this browser and sends it to
 * Google; the callback is accepted only when Google hands the same value back
 * to the same browser. Without it a page could send someone's browser to the
 * callback with the page owner's own Google code and sign them into the
 * owner's account (login CSRF).
 *
 * SameSite=Lax: the callback is a top-level GET navigation from
 * accounts.google.com, which Lax lets through and Strict would not.
 */

const BASE_NAME = 'zimos_gstate';
const COOKIE_PATH = `/api/${env.apiVersion}/auth/google`;
const TTL_MS = 10 * 60 * 1000;

// Cookies ignore ports: outside production the port is in the name, so two
// local servers do not read each other's state.
const cookieName = () => (env.isProduction ? BASE_NAME : `${BASE_NAME}_${env.port}`);

const cookieOptions = () => ({ httpOnly: true, secure: env.isProduction, sameSite: 'lax', path: COOKIE_PATH });

/** A new state for this browser; returns the value to put in Google's URL. */
function issue(res) {
  const state = crypto.randomBytes(32).toString('hex');
  res.cookie(cookieName(), state, { ...cookieOptions(), maxAge: TTL_MS });
  return state;
}

/** True when the callback's `state` is the one this browser was given. The cookie is used once. */
function consume(req, res) {
  const expected = (req.cookies && req.cookies[cookieName()]) || '';
  res.clearCookie(cookieName(), cookieOptions());
  const given = typeof req.query.state === 'string' ? req.query.state : '';
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

module.exports = { issue, consume, cookieName };
