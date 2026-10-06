'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { NotFoundError } = require('../../../core/errors/AppError');
const { getProvider } = require('./index');

/**
 * The person's devices and the pushes sent to them (SPEC §20 PWA web push).
 * Mounted at /api/v1/me/push: a device belongs to a person, not a store; a
 * merchant notification of any of their stores reaches all their devices.
 */

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const view = (d) => ({ id: d.id, platform: d.platform, userAgent: d.userAgent, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt });

async function register(userId, { platform, token, userAgent }) {
  const tokenHash = hash(token);
  const existing = await db.DeviceToken.findOne({ where: { userId, tokenHash } });
  if (existing) {
    await existing.update({ lastSeenAt: new Date(), userAgent: userAgent || existing.userAgent });
    return existing;
  }
  return db.DeviceToken.create({ userId, platform, token, tokenHash, userAgent: userAgent || null, lastSeenAt: new Date() });
}

/** Sends one message to every device of the person. Never throws. */
async function sendToUser(userId, message) {
  const provider = getProvider();
  if (!provider) return { sent: 0 };
  const devices = await db.DeviceToken.findAll({ where: { userId } });
  let sent = 0;
  for (const device of devices) {
    try {
      await provider.send(device, message);
      sent += 1;
    } catch (err) {
      if (err && err.gone) await device.destroy().catch(() => {});
      else logger.warn('Push failed', { userId, deviceId: device.id, message: err.message });
    }
  }
  return { sent };
}

// ---------------------------------------------------------------- routes --

const router = Router();
router.use(authenticate);

// What the dashboard needs to subscribe: the provider and its VAPID key (null = no real web push here).
router.get(
  '/config',
  asyncHandler(async (req, res) => {
    const provider = getProvider();
    res.json({ push: { available: Boolean(provider), provider: provider ? provider.name : null, publicKey: provider ? provider.publicKey() : null } });
  })
);

router.get(
  '/devices',
  asyncHandler(async (req, res) => {
    const devices = await db.DeviceToken.findAll({ where: { userId: req.user.id }, order: [['lastSeenAt', 'DESC']] });
    res.json({ devices: devices.map(view) });
  })
);

router.post(
  '/devices',
  validate({
    body: Joi.object({
      platform: Joi.string().valid('web', 'ios', 'android').required(),
      token: Joi.string().min(8).max(4000).required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const device = await register(req.user.id, { ...req.body, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });
    res.status(201).json({ device: view(device) });
  })
);

router.delete(
  '/devices/:deviceId',
  validate({ params: Joi.object({ deviceId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const removed = await db.DeviceToken.destroy({ where: { id: req.params.deviceId, userId: req.user.id } });
    if (!removed) throw new NotFoundError('Device');
    res.status(204).end();
  })
);

module.exports = { router, register, sendToUser };
