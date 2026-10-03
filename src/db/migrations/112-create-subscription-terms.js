'use strict';

/**
 * Special terms a platform admin grants a subscription outside normal plan
 * pricing (billing/specialTermsService). One row per grant, never edited
 * after the fact except for the override's use count:
 *
 *   free_months     the subscription is covered for `months` more months,
 *                   from starts_at to ends_at, with no charge. The next
 *                   charge starts after ends_at.
 *   price_override  the next `charges_total` charges are priced at
 *                   price_amount (in currency) instead of the plan's price;
 *                   charges_used counts how many have been.
 *
 * `note` (what was agreed and why) is required on every grant.
 *
 * billing_invoices.special_terms_id: the price override a charge was priced
 * with, if any.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'subscription_terms',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          subscription_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'subscriptions', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          kind: { type: DataTypes.STRING(20), allowNull: false },
          months: { type: DataTypes.INTEGER, allowNull: true },
          starts_at: { type: DataTypes.DATE, allowNull: true },
          ends_at: { type: DataTypes.DATE, allowNull: true },
          price_amount: { type: DataTypes.BIGINT, allowNull: true },
          currency: { type: DataTypes.STRING(3), allowNull: true },
          charges_total: { type: DataTypes.INTEGER, allowNull: true },
          charges_used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          note: { type: DataTypes.TEXT, allowNull: false },
          created_by_user_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE subscription_terms
           ADD CONSTRAINT subscription_terms_kind_check CHECK (
             (kind = 'free_months' AND months BETWEEN 1 AND 36 AND starts_at IS NOT NULL
               AND ends_at > starts_at AND price_amount IS NULL AND charges_total IS NULL)
             OR (kind = 'price_override' AND price_amount >= 0 AND currency ~ '^[A-Z]{3}$'
               AND charges_total BETWEEN 1 AND 36 AND charges_used BETWEEN 0 AND charges_total
               AND months IS NULL AND starts_at IS NULL AND ends_at IS NULL)
           ),
           ADD CONSTRAINT subscription_terms_note_check CHECK (length(trim(note)) > 0)`,
        { transaction }
      );
      await queryInterface.addIndex('subscription_terms', ['subscription_id', 'created_at'], {
        name: 'subscription_terms_subscription_idx',
        transaction,
      });

      await queryInterface.addColumn(
        'billing_invoices',
        'special_terms_id',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'subscription_terms', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('billing_invoices', 'special_terms_id', { transaction });
      await queryInterface.dropTable('subscription_terms', { transaction });
    });
  },
};
