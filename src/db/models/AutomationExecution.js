'use strict';

module.exports = (sequelize, DataTypes) => {
  // One pass of an automation rule over one order or lost checkout
  // (modules/automations/automationExecutor.js).
  const AutomationExecution = sequelize.define(
    'AutomationExecution',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      ruleId: { type: DataTypes.UUID, allowNull: true, field: 'rule_id' },
      trigger: { type: DataTypes.STRING(100), allowNull: false },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      checkoutSessionId: { type: DataTypes.UUID, allowNull: true, field: 'checkout_session_id' },
      // running | waiting | completed | stopped
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'running' },
      // The rule's steps as they were when the execution started: editing the
      // rule does not change a sequence that is already under way.
      steps: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      nextStepIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'next_step_index' },
      // { signature, stopOnStatusChange, couponCode, … }
      context: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      resumeAt: { type: DataTypes.DATE, allowNull: true, field: 'resume_at' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    },
    { tableName: 'automation_executions', indexes: [{ fields: ['workspace_id', 'status'] }, { fields: ['order_id'] }] }
  );
  return AutomationExecution;
};
