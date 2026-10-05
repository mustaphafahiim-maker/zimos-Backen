'use strict';

const crypto = require('crypto');

/**
 * Encrypts merchant integration secrets (API tokens) at rest with
 * AES-256-GCM. The key comes from INTEGRATIONS_ENCRYPTION_KEY (any string;
 * it is hashed to 32 bytes). Without it, sealing or opening a secret throws
 * in every environment; the API still starts.
 */
function key() {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  // No fallback in any environment: a secret is never sealed with a key written in code.
  if (!raw) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is not set: an integration secret cannot be sealed or opened');
  if (process.env.NODE_ENV !== 'test' && raw.startsWith('test-only-')) throw new Error("INTEGRATIONS_ENCRYPTION_KEY holds the test suite's value: set a real one");
  return crypto.createHash('sha256').update(raw).digest();
}

function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

function open(sealed) {
  if (!sealed) return null;
  const [version, iv, tag, data] = String(sealed).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** "EAAG…abcd" → "••••abcd" for display. */
function mask(secret) {
  if (!secret) return null;
  const s = String(secret);
  return `••••${s.slice(-4)}`;
}

module.exports = { seal, open, mask };
