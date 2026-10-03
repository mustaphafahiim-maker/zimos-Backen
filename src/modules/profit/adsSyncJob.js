'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const { getAdsAdapter } = require('./adapters');
const { upsertOne, storeCurrency } = require('./adSpendService');

/**
 * `ads.sync_spend`: pulls the last days of spend from every connected ad
 * account (adapters/README.md). With only the sandbox adapter registered it
 * finds nothing to write; it exists so a real adapter only has to be added.
 */

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_DAYS = 3;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function openSecrets(integration) {
  if (!integration.secretsSealed) return null;
  try {
    return JSON.parse(secretBox.open(integration.secretsSealed));
  } catch {
    return null;
  }
}

async function syncIntegration(integration) {
  const adapter = getAdsAdapter(integration.provider.slice('ads:'.length));
  if (!adapter) return 0;
  const now = Date.now();
  const rows = await adapter.fetchDailySpend({
    config: integration.config || {},
    secrets: openSecrets(integration),
    from: day(now - LOOKBACK_DAYS * 24 * HOUR_MS),
    to: day(now),
  });
  const currency = await storeCurrency(integration.workspaceId);
  for (const row of rows) await upsertOne(integration.workspaceId, row, { source: 'sync', currency });
  await integration.update({ lastVerifiedAt: new Date(), lastError: null });
  return rows.length;
}

/** Every connected ad account, or only one store's. Never throws. */
async function syncSpend({ workspaceId } = {}) {
  const where = { provider: { [Op.like]: 'ads:%' }, status: 'connected' };
  if (workspaceId) where.workspaceId = workspaceId;
  const integrations = await db.WorkspaceIntegration.findAll({ where });
  const result = { accounts: integrations.length, written: 0, failed: 0 };
  for (const integration of integrations) {
    try {
      result.written += await syncIntegration(integration);
    } catch (err) {
      result.failed += 1;
      logger.warn('ads.sync_spend failed for an account', {
        workspaceId: integration.workspaceId, provider: integration.provider, error: err.message,
      });
      await integration.update({ lastError: String(err.message).slice(0, 500) }).catch(() => {});
    }
  }
  return result;
}

let timer = null;
function startAdsSync() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => {
    syncSpend().catch((err) => logger.warn('ads.sync_spend run failed', { error: err.message }));
  }, HOUR_MS);
  timer.unref();
}

module.exports = { syncSpend, startAdsSync };
