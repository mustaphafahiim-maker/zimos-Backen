'use strict';

const { OAuth2Client } = require('google-auth-library');

/** Google: verifies an ID token from Google Identity Services (the "Sign in with Google" button). */
async function verify(idToken, clientId) {
  const ticket = await new OAuth2Client(clientId).verifyIdToken({ idToken, audience: clientId });
  const p = ticket.getPayload();
  return { subject: p.sub, email: p.email ? String(p.email).toLowerCase() : null, emailVerified: p.email_verified === true, name: p.name || null };
}

module.exports = { name: 'google', verify };
