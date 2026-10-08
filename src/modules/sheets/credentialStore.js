'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');

/**
 * Hooks the Google adapter calls on the credentials it was handed
 * (adapters/README.md): `onRefresh` keeps a refreshed access token, sealed, in
 * the store's `google_sheets` row; `onRevoked` marks the account revoked so the
 * dashboard asks the merchant to connect again. Both act only while the row
 * still holds the same refresh token, so a reconnect made meanwhile is never
 * overwritten. The hooks are not enumerable: JSON.stringify never sees them.
 */

const PROVIDER = 'google_sheets';

async function withRow(workspaceId, refreshToken, fn) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.status !== 'connected' || !row.secretsSealed) return false;
    let stored;
    try {
      stored = JSON.parse(secretBox.open(row.secretsSealed));
    } catch {
      return false;
    }
    if (!stored || stored.refreshToken !== refreshToken) return false;
    await fn(row, stored, transaction);
    return true;
  });
}

async function saveRefreshed(workspaceId, previousRefreshToken, next) {
  await withRow(workspaceId, previousRefreshToken, (row, stored, transaction) =>
    row.update({ secretsSealed: secretBox.seal(JSON.stringify({ ...stored, ...next })), lastVerifiedAt: new Date(), lastError: null }, { transaction })
  );
}

async function markRevoked(workspaceId, refreshToken, reason) {
  const done = await withRow(workspaceId, refreshToken, (row, stored, transaction) =>
    // The tokens are dead: nothing is kept.
    row.update({ status: 'revoked', secretsSealed: null, lastError: 'Google access was removed — connect the account again' }, { transaction })
  );
  if (done) logger.info('[sheets] Google account access revoked', { workspaceId, reason });
}

/** The credentials, with the hooks for this store. */
function attach(workspaceId, credentials) {
  if (!credentials || typeof credentials !== 'object') return credentials;
  let current = credentials.refreshToken;
  Object.defineProperty(credentials, 'onRefresh', {
    enumerable: false,
    value: async (next) => {
      await saveRefreshed(workspaceId, current, next);
      current = next.refreshToken || current;
    },
  });
  Object.defineProperty(credentials, 'onRevoked', { enumerable: false, value: (reason) => markRevoked(workspaceId, current, reason) });
  return credentials;
}

module.exports = { attach };
