'use strict';

const env = require('../../config/env');

/**
 * The refresh token as an httpOnly cookie (SPEC §3.4-2), so page scripts can
 * never read it. The cookie is limited to the auth routes, where refresh and
 * logout read it; the access token stays in the browser's memory.
 *
 * A browser client opts in per request with `X-Zimos-Token-Mode: cookie`: the
 * cookie is set and the refresh token is left out of the JSON body. Callers
 * that do not send the header (mobile apps, scripts, an older dashboard build)
 * keep getting the token in the body.
 *
 * `X-Zimos-App` names the cookie per app, so the merchant dashboard and the
 * platform admin — two origins, one API host — do not share a session.
 */

const BASE_NAME = 'zimos_rt';
const COOKIE_PATH = `/api/${env.apiVersion}/auth`;

function parseDurationMs(value) {
  const match = /^(\d+)\s*([smhd])?$/.exec(String(value || '').trim());
  if (!match) return 30 * 24 * 3600 * 1000;
  const unit = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 }[match[2] || 's'];
  return Number(match[1]) * unit;
}

function cookieName(req) {
  const app = String(req.get('x-zimos-app') || '').trim().toLowerCase();
  const name = /^[a-z]{1,20}$/.test(app) ? `${BASE_NAME}_${app}` : BASE_NAME;
  // Cookies ignore ports: several APIs on one machine (localhost:4000, :4101…)
  // would overwrite each other's session. Outside production the port is in the name.
  return env.isProduction ? name : `${name}_${env.port}`;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookie.secure,
    sameSite: env.authCookie.sameSite,
    path: COOKIE_PATH,
  };
}

const wantsCookie = (req) => env.authCookie.enabled && String(req.get('x-zimos-token-mode') || '').toLowerCase() === 'cookie';

function set(req, res, refreshToken) {
  res.cookie(cookieName(req), refreshToken, { ...cookieOptions(), maxAge: parseDurationMs(env.jwt.refreshExpiresIn) });
}

function clear(req, res) {
  res.clearCookie(cookieName(req), cookieOptions());
}

function read(req) {
  if (!env.authCookie.enabled) return null;
  return (req.cookies && req.cookies[cookieName(req)]) || null;
}

/**
 * Mounted on the auth router. Any auth answer carrying a `refreshToken`
 * (login, sign-up confirmation, refresh…) has it moved into the cookie for
 * clients in cookie mode; refresh and logout fall back to the cookie when the
 * body has no token.
 */
function attach(req, res, next) {
  if (/\/(refresh|logout)$/.test(req.path)) {
    if (!req.body || typeof req.body !== 'object') req.body = {};
    const fromCookie = req.body.refreshToken ? null : read(req);
    if (fromCookie) req.body.refreshToken = fromCookie;
  }
  if (wantsCookie(req)) {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && typeof body.refreshToken === 'string') {
        set(req, res, body.refreshToken);
        const { refreshToken, ...rest } = body;
        return json(rest);
      }
      return json(body);
    };
  }
  if (/\/logout$/.test(req.path)) clear(req, res);
  next();
}

module.exports = { attach, set, clear, read, wantsCookie, cookieName };
