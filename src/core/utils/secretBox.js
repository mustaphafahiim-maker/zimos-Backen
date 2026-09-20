'use strict';

const crypto = require('crypto');
const logger = require('./logger');

/**
 * Encrypts merchant integration secrets (API tokens) at rest with
 * AES-256-GCM. The key comes from INTEGRATIONS_ENCRYPTION_KEY (any string;
 * it is hashed to 32 bytes). Production refuses to run without it; other
 * environments fall back to a fixed development key with a warning.
 */
let warned = false;
function key() {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (raw) return crypto.createHash('sha256').update(raw).digest();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('INTEGRATIONS_ENCRYPTION_KEY must be set in production');
  }
  if (!warned && process.env.NODE_ENV !== 'test') {
    logger.warn('INTEGRATIONS_ENCRYPTION_KEY is not set — using a development-only key');
    warned = true;
  }
  return crypto.createHash('sha256').update('zimos-development-only-integrations-key').digest();
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
