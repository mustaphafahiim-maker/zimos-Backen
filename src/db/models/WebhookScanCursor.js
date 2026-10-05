'use strict';
module.exports = (sequelize, DataTypes) => {
  // How far through updated_at a webhook scanner has read (migration 117).
  // The row doubles as the scanner's lock — see orderChangeDetector.js.
  const WebhookScanCursor = sequelize.define(
    'WebhookScanCursor',
    {
      name: { type: DataTypes.STRING(50), primaryKey: true },
      scannedUntil: { type: DataTypes.DATE, allowNull: false, field: 'scanned_until' },
    },
    { tableName: 'webhook_scan_cursors' }
  );
  return WebhookScanCursor;
};
