'use strict';

/**
 * Shopper-filled fields on a product ("name to engrave", "your photo") and the
 * photos shoppers upload for them.
 *
 *  - products.custom_fields: the merchant's field definitions, at most five
 *    (catalog/customFields.js validates the shape). '[]' is "none", which is
 *    every product today.
 *  - cart_items.customizations / order_items.customizations: what the shopper
 *    filled in, as a snapshot that carries each field's label at the time, so
 *    a later edit to the product never rewrites an order. Null is "none".
 *  - customer_uploads: one row per photo a shopper uploaded through the public
 *    storefront (never the merchant's media library). `pending` until an order
 *    takes it (`attached`, with the order item), and swept from storage and the
 *    table once `expires_at` passes while still pending. `visitor_id` is the
 *    storefront's anonymous visitor id and `cart_id` the cart the photo went
 *    into — how the order proves the photo is the shopper's own.
 *
 * `status` is a checked VARCHAR rather than an ENUM, so a later state needs no
 * ALTER TYPE. The new table starts empty, so its indexes need no CONCURRENTLY;
 * adding columns with a constant default is metadata-only in PostgreSQL 11+.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const products = await queryInterface.describeTable('products');
    if (!products.custom_fields) {
      await queryInterface.addColumn('products', 'custom_fields', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      });
    }
    const cartItems = await queryInterface.describeTable('cart_items');
    if (!cartItems.customizations) {
      await queryInterface.addColumn('cart_items', 'customizations', { type: Sequelize.JSONB, allowNull: true });
    }
    const orderItems = await queryInterface.describeTable('order_items');
    if (!orderItems.customizations) {
      await queryInterface.addColumn('order_items', 'customizations', { type: Sequelize.JSONB, allowNull: true });
    }

    await queryInterface.createTable('customer_uploads', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.UUIDV4 },
      workspace_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // Storage key: customer-uploads/<workspaceId>/<uuid>.<ext>. Never served publicly.
      path: { type: Sequelize.STRING(500), allowNull: false },
      mime: { type: Sequelize.STRING(50), allowNull: false },
      size_bytes: { type: Sequelize.INTEGER, allowNull: false },
      width: { type: Sequelize.INTEGER, allowNull: true },
      height: { type: Sequelize.INTEGER, allowNull: true },
      visitor_id: { type: Sequelize.STRING(64), allowNull: false },
      cart_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'carts', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      product_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'products', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      order_item_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'order_items', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.sequelize.query(
      "ALTER TABLE customer_uploads ADD CONSTRAINT customer_uploads_status_check CHECK (status IN ('pending', 'attached'))"
    );
    // A shopper's pending photos (the per-session cap), the sweep, and an order's photos.
    await queryInterface.addIndex('customer_uploads', ['workspace_id', 'visitor_id', 'status'], {
      name: 'customer_uploads_workspace_visitor_status_idx',
    });
    await queryInterface.addIndex('customer_uploads', ['status', 'expires_at'], { name: 'customer_uploads_status_expires_idx' });
    await queryInterface.addIndex('customer_uploads', ['order_item_id'], { name: 'customer_uploads_order_item_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('customer_uploads');
    await queryInterface.removeColumn('order_items', 'customizations');
    await queryInterface.removeColumn('cart_items', 'customizations');
    await queryInterface.removeColumn('products', 'custom_fields');
  },
};
