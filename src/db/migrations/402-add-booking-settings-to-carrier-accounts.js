'use strict';

/**
 * How each connected courier books (SPEC §12.2 carrier accounts): the
 * store's default courier, when it books on its own (never / once the order
 * is confirmed / once it is paid), whether the customer may open the parcel
 * before accepting it, and notes every booking carries for the courier.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('carrier_accounts', 'is_default', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('carrier_accounts', 'auto_create_on', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'never' });
    await queryInterface.addColumn('carrier_accounts', 'allow_inspection', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('carrier_accounts', 'courier_notes', { type: DataTypes.STRING(500), allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('carrier_accounts', 'courier_notes');
    await queryInterface.removeColumn('carrier_accounts', 'allow_inspection');
    await queryInterface.removeColumn('carrier_accounts', 'auto_create_on');
    await queryInterface.removeColumn('carrier_accounts', 'is_default');
  },
};
