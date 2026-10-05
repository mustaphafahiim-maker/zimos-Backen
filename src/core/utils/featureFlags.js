'use strict';

const crypto = require('crypto');
const db = require('../../db/models');

/**
 * Whether a platform FeatureFlag is on for a store: the flag is enabled and
 * the store is targeted, or falls inside its rollout percentage (a stable
 * bucket per store and key).
 */
async function isOn(key, workspaceId) {
  const flag = await db.FeatureFlag.findOne({ where: { key } });
  if (!flag || !flag.enabled) return false;
  const targets = Array.isArray(flag.targetWorkspaceIds) ? flag.targetWorkspaceIds : [];
  if (workspaceId && targets.includes(workspaceId)) return true;
  if (flag.rollout >= 100) return true;
  if (flag.rollout <= 0 || !workspaceId) return false;
  const bucket = crypto.createHash('sha256').update(`${key}:${workspaceId}`).digest().readUInt16BE(0) % 100;
  return bucket < flag.rollout;
}

module.exports = { isOn };
