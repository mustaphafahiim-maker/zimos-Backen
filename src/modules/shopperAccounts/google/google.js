'use strict';

const { OAuth2Client } = require('google-auth-library');

/** Google: verifies an ID token from Google Identity Services (the "Sign in with Google" button). */
async function verify(idToken, clientId) {
  const ticket = await new OAuth2Client(clientId).verifyIdToken({ idToken, audience: clientId });
  const p = ticket.getPayload();
  // nonce: the store's sign-in nonce the button was given (item 279), checked by the caller.
  return { subject: p.sub, email: p.email ? String(p.email).toLowerCase() : null, emailVerified: p.email_verified === true, name: p.name || null, nonce: p.nonce || null };
}

module.exports = { name: 'google', verify };
