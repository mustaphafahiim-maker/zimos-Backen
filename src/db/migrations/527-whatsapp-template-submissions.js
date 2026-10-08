'use strict';

/**
 * Ready-made WhatsApp templates submitted to Meta from ZIMOS (spec-gaps item
 * 391, whatsapp/templateSubmission.js).
 *
 * whatsapp_templates gains:
 *   automation_rule_id     the rule this template was submitted for (the
 *                          ready-made automation's rule); null for a template
 *                          only synced from Meta. SET NULL when the rule goes.
 *   activate_rule          the merchant asked for that rule to turn on once
 *                          its templates are approved; cleared when it does
 *   submitted_at           when ZIMOS submitted (or linked) it
 *   submitted_by           the teammate who did
 *   rejection_notified_at  the bell for its rejection went out; cleared when
 *                          the status moves away from REJECTED, so a later
 *                          rejection is told again
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('whatsapp_templates', 'automation_rule_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'automation_rules', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn('whatsapp_templates', 'activate_rule', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('whatsapp_templates', 'submitted_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('whatsapp_templates', 'submitted_by', { type: DataTypes.UUID, allowNull: true });
    await queryInterface.addColumn('whatsapp_templates', 'rejection_notified_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS whatsapp_templates_rule_idx ON whatsapp_templates (automation_rule_id) WHERE automation_rule_id IS NOT NULL'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS whatsapp_templates_rule_idx');
    await queryInterface.removeColumn('whatsapp_templates', 'rejection_notified_at');
    await queryInterface.removeColumn('whatsapp_templates', 'submitted_by');
    await queryInterface.removeColumn('whatsapp_templates', 'submitted_at');
    await queryInterface.removeColumn('whatsapp_templates', 'activate_rule');
    await queryInterface.removeColumn('whatsapp_templates', 'automation_rule_id');
  },
};
