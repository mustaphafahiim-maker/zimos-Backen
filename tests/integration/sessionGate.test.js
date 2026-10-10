'use strict';

// Ending a session cuts its access token at once (core/security/sessionGate):
// the access token names its session (`sid`), and every authenticated request
// checks that session (or the session it was refreshed into) still stands.

const { app, request, registerAndActivate } = require('../helpers/factories');
const { signAccessToken, verifyAccessToken } = require('../../src/core/security/tokens');

const me = (token) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

describe('session gate', () => {
  it('an access token names its session', async () => {
    const user = await registerAndActivate();
    expect(verifyAccessToken(user.accessToken).sid).toBeTruthy();
  });

  it('signing out ends the access token at once, not when it expires', async () => {
    const user = await registerAndActivate();
    expect((await me(user.accessToken)).status).toBe(200);

    await request(app).post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken }).expect(200);
    const after = await me(user.accessToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_ENDED');
  });

  it('a refresh keeps the old access token working (a request in flight), and signing out ends both', async () => {
    const user = await registerAndActivate();
    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await me(user.accessToken)).status).toBe(200);
    expect((await me(refreshed.body.accessToken)).status).toBe(200);

    await request(app).post('/api/v1/auth/sessions/revoke-all').set('Authorization', `Bearer ${refreshed.body.accessToken}`).expect(200);
    expect((await me(user.accessToken)).status).toBe(401);
    expect((await me(refreshed.body.accessToken)).status).toBe(401);
  });

  it('a token from before sessions were named is let through until it expires', async () => {
    const user = await registerAndActivate();
    const legacy = signAccessToken({ sub: user.userId });
    expect((await me(legacy)).status).toBe(200);
  });
});
