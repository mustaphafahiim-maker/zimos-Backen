'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { recordAudit } = require('../audit/auditService');

/**
 * POST /checkout-sessions/bulk-delete { ids } — the lost orders screen\'s
 * bulk delete (SPEC §6.3 "Bulk: … delete"). Same rule as one delete: a
 * checkout that became an order stays (it is the order\'s history), and is
 * reported as skipped. At most 500 at a time.
 */
const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  body: Joi.object({ ids: Joi.array().items(Joi.string().uuid()).min(1).max(500).unique().required() }),
};

const handler = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const { Op } = db.Sequelize;
  const result = await db.sequelize.transaction(async (transaction) => {
    const rows = await db.CheckoutSession.findAll({
      where: { workspaceId, id: req.body.ids },
      attributes: ['id', 'status'],
      transaction,
    });
    const deletable = rows.filter((r) => r.status !== 'converted').map((r) => r.id);
    if (deletable.length) await db.CheckoutSession.destroy({ where: { workspaceId, id: { [Op.in]: deletable } }, transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'checkout_session.bulk_deleted',
      entityType: 'CheckoutSession',
      metadata: { deleted: deletable.length, skippedConverted: rows.length - deletable.length },
      req,
      transaction,
    });
    return { deleted: deletable.length, skipped: req.body.ids.length - deletable.length };
  });
  res.json(result);
});

module.exports = { schema, handler };
