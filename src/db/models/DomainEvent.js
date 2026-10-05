'use strict';

module.exports = (sequelize, DataTypes) => {
  // The event outbox (core/outbox/outbox.js): written in the same transaction
  // as the change it describes, handed to the queue by the worker.
  const DomainEvent = sequelize.define(
    'DomainEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      type: { type: DataTypes.STRING(80), allowNull: false },
      aggregateType: { type: DataTypes.STRING(60), allowNull: true, field: 'aggregate_type' },
      aggregateId: { type: DataTypes.STRING(80), allowNull: true, field: 'aggregate_id' },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'occurred_at' },
      dispatchedAt: { type: DataTypes.DATE, allowNull: true, field: 'dispatched_at' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'domain_events', timestamps: false }
  );
  return DomainEvent;
};
