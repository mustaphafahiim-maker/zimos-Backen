'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A store's own couriers (modules/couriers): the people who deliver its
 * orders when it has no shipping company.
 *
 *  - couriers                      name (unique per store, any case), phone, active
 *  - shipments.courier_id          the courier carrying the parcel; null = none
 *                                  chosen (a shipping company, or a name typed
 *                                  as free text before this table existed)
 *  - cod_settlements.courier_id    the courier whose cash the settlement counts
 *
 * Nothing is backfilled: shipments keep their carrier_code text, and a
 * courier created later with the same name links them (couriersService).
 * Both new columns are nullable with no default, so adding them to a large
 * shipments table is a catalogue change; its index is built CONCURRENTLY by
 * the guard (outside a transaction).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') };
    await queryInterface.createTable('couriers', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      phone: { type: DataTypes.STRING(32), allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS couriers_workspace_name_uq ON couriers (workspace_id, lower(name))'
    );

    await queryInterface.addColumn('shipments', 'courier_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'couriers', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('shipments', ['courier_id'], { name: 'shipments_courier_id_idx' });

    await queryInterface.addColumn('cod_settlements', 'courier_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'couriers', key: 'id' },
      onDelete: 'SET NULL',
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('cod_settlements', 'courier_id');
    await queryInterface.removeIndex('shipments', 'shipments_courier_id_idx');
    await queryInterface.removeColumn('shipments', 'courier_id');
    await queryInterface.dropTable('couriers');
  },
};
