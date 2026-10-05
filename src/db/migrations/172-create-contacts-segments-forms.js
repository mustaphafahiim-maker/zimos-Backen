'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently } = require('../concurrentIndex');

/**
 * Contacts and segments (SPEC §18.4).
 *
 * A customer row is now a "contact": someone who ordered (customer) or only
 * left their details (lead). The type is derived from the orders, never
 * stored. What is stored:
 *
 *   customers.tags    free labels the merchant or a page form adds. The old
 *                     `segments` array (never written by any screen) is
 *                     copied in, so the two are one list from here on.
 *   customers.source  where the contact first came from: checkout, form,
 *                     manual, import.
 *   segments          a saved filter (`rules` jsonb), evaluated when used.
 *   form_submissions  every submit of a page `form` element.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const workspace = {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    };

    const addedTags = await queryInterface.addColumn('customers', 'tags', {
      type: DataTypes.ARRAY(DataTypes.STRING(60)),
      allowNull: false,
      defaultValue: [],
    });
    const addedSource = await queryInterface.addColumn('customers', 'source', { type: DataTypes.STRING(20), allowNull: true });
    if (addedTags) await queryInterface.sequelize.query(
      `UPDATE customers SET tags = segments::varchar(60)[] WHERE cardinality(segments) > 0`
    );
    if (addedSource) await queryInterface.sequelize.query(`UPDATE customers SET source = 'checkout' WHERE total_orders > 0`);
    await createIndexConcurrently(queryInterface, { name: 'customers_tags_gin', table: 'customers', definition: `USING GIN (tags)` });
    await queryInterface.addIndex('customers', ['workspace_id', 'created_at', 'id'], {
      name: 'customers_ws_created_idx',
    });

    await queryInterface.createTable('segments', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspace,
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.STRING(300), allowNull: true },
      rules: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('segments', ['workspace_id', 'name'], { unique: true, name: 'segments_ws_name_uq' });

    await queryInterface.createTable('form_submissions', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspace,
      customer_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'customers', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      form_name: { type: DataTypes.STRING(200), allowNull: false },
      page_path: { type: DataTypes.STRING(500), allowNull: true },
      element_id: { type: DataTypes.STRING(100), allowNull: true },
      full_name: { type: DataTypes.STRING(200), allowNull: true },
      phone: { type: DataTypes.STRING(32), allowNull: true },
      email: { type: DataTypes.STRING(255), allowNull: true },
      message: { type: DataTypes.TEXT, allowNull: true },
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
      marketing_consent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      ip_address: { type: DataTypes.STRING(64), allowNull: true },
      is_read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('form_submissions', ['workspace_id', 'created_at', 'id'], {
      name: 'form_submissions_ws_created_idx',
    });
    await queryInterface.addIndex('form_submissions', ['customer_id'], { name: 'form_submissions_customer_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('form_submissions');
    await queryInterface.dropTable('segments');
    await queryInterface.removeIndex('customers', 'customers_ws_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS customers_tags_gin');
    await queryInterface.removeColumn('customers', 'source');
    await queryInterface.removeColumn('customers', 'tags');
  },
};
