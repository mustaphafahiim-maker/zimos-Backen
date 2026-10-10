'use strict';

const request = require('supertest');
const app = require('../../src/app');

/**
 * A Google callback as a browser makes it: GET /auth/google first (which
 * sets the OAuth state cookie, auth/googleState.js), then the callback with
 * that state in the query and the cookie sent back. `qs` is the rest of the
 * callback's query string (code=… or error=…).
 */
async function googleCallback(qs) {
  const start = await request(app).get('/api/v1/auth/google').redirects(0);
  const cookie = (start.headers['set-cookie'] || []).find((c) => c.startsWith('zimos_gstate'));
  if (!cookie) throw new Error('GET /auth/google set no state cookie');
  const pair = cookie.split(';')[0];
  const state = pair.slice(pair.indexOf('=') + 1);
  return request(app).get(`/api/v1/auth/google/callback?${qs}&state=${state}`).set('Cookie', pair).redirects(0);
}

module.exports = { googleCallback };
