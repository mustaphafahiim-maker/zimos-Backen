'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * A store's own couriers (migration 216): the people who deliver its orders
 * when it has no shipping company. A courier is picked from a list when an
 * order goes out (orders/orderStageChange.js), and the delivery sheet and the
 * COD settlements group by courier id.
 *
 * Before this table, a courier was a name typed as free text into the
 * shipment's carrier_code. Those shipments are never rewritten: creating a
 * courier (or renaming one) links every unlinked shipment of the store whose
 * carrier_code is that name, ignoring case and outer spaces, and the names
 * still typed by nobody's courier are listed (legacyNames) so the merchant
 * can add them in one click.
 */

const view = (c) => ({ id: c.id, name: c.name, phone: c.phone, active: c.active, createdAt: c.createdAt });

const norm = (name) => String(name || '').trim().replace(/\s+/g, ' ');

function nameTaken(err) {
  return err && err.name === 'SequelizeUniqueConstraintError'
    ? new AppError('COURIER_NAME_TAKEN', 'This store already has a courier with this name', 409, [{ field: 'name', message: 'Already used' }])
    : err;
}

/** Links the store's shipments typed with this courier's name before the courier existed. */
async function linkByName(courier, transaction) {
  const [, meta] = await db.sequelize.query(
    `UPDATE shipments SET courier_id = :id
      WHERE workspace_id = :ws AND courier_id IS NULL
        AND lower(btrim(carrier_code)) = lower(btrim(:name))`,
    { replacements: { id: courier.id, ws: courier.workspaceId, name: courier.name }, transaction }
  );
  return meta && typeof meta.rowCount === 'number' ? meta.rowCount : 0;
}

async function list(workspaceId) {
  const rows = await db.Courier.findAll({ where: { workspaceId }, order: [['active', 'DESC'], ['name', 'ASC']] });
  return rows.map(view);
}

/** The courier, or 404 — only this store's. With `activeOnly`, an inactive one is refused (422). */
async function findForStore(workspaceId, courierId, { activeOnly = false, transaction } = {}) {
  const courier = await db.Courier.findOne({ where: { id: courierId, workspaceId }, transaction });
  if (!courier) throw new NotFoundError('Courier');
  if (activeOnly && !courier.active) {
    throw new AppError('COURIER_INACTIVE', 'This courier is switched off', 422, [{ field: 'courierId', message: 'Inactive courier' }]);
  }
  return courier;
}

async function create(workspaceId, body, req) {
  return db.sequelize
    .transaction(async (transaction) => {
      const courier = await db.Courier.create(
        { workspaceId, name: norm(body.name), phone: body.phone ? body.phone.trim() : null, active: body.active !== false },
        { transaction }
      );
      const linkedShipments = await linkByName(courier, transaction);
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'courier.create',
        entityType: 'Courier',
        entityId: courier.id,
        after: view(courier),
        metadata: linkedShipments ? { linkedShipments } : null,
        req,
        transaction,
      });
      return { courier: view(courier), linkedShipments };
    })
    .catch((err) => {
      throw nameTaken(err);
    });
}

async function update(workspaceId, courierId, body, req) {
  return db.sequelize
    .transaction(async (transaction) => {
      const courier = await findForStore(workspaceId, courierId, { transaction });
      const before = view(courier);
      if (body.name !== undefined) courier.name = norm(body.name);
      if (body.phone !== undefined) courier.phone = body.phone ? body.phone.trim() : null;
      if (body.active !== undefined) courier.active = body.active;
      await courier.save({ transaction });
      const linkedShipments = body.name !== undefined ? await linkByName(courier, transaction) : 0;
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'courier.update',
        entityType: 'Courier',
        entityId: courier.id,
        before,
        after: view(courier),
        metadata: linkedShipments ? { linkedShipments } : null,
        req,
        transaction,
      });
      return { courier: view(courier), linkedShipments };
    })
    .catch((err) => {
      throw nameTaken(err);
    });
}

/** Deletes a courier who never carried a parcel; one who did is switched off instead (409 COURIER_IN_USE). */
async function remove(workspaceId, courierId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const courier = await findForStore(workspaceId, courierId, { transaction });
    const used = await db.Shipment.count({ where: { workspaceId, courierId: courier.id }, transaction });
    if (used > 0) {
      throw new AppError('COURIER_IN_USE', 'This courier has carried orders: switch them off instead of deleting them', 409);
    }
    await courier.destroy({ transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'courier.delete', entityType: 'Courier', entityId: courier.id, before: view(courier), req, transaction });
    return { deleted: true, id: courier.id };
  });
}

/**
 * Names typed as a courier before the store had couriers, not yet linked to
 * one: [{ name, shipments }]. Shipping companies, 'manual' and store pickup
 * are not couriers' names and are left out.
 */
async function legacyNames(workspaceId) {
  const companies = require('../shipping/carriers')
    .listRegistered()
    .map(({ adapter }) => adapter.code);
  const skip = [...companies, 'manual', 'pickup'];
  const [rows] = await db.sequelize.query(
    `SELECT min(btrim(carrier_code)) AS name, count(*)::int AS shipments
       FROM shipments
      WHERE workspace_id = :ws AND courier_id IS NULL AND btrim(carrier_code) <> ''
        AND lower(btrim(carrier_code)) NOT IN (:skip)
      GROUP BY lower(btrim(carrier_code))
      ORDER BY count(*) DESC
      LIMIT 50`,
    { replacements: { ws: workspaceId, skip } }
  );
  return rows;
}

module.exports = { list, create, update, remove, legacyNames, findForStore, linkByName };
