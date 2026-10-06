'use strict';

/**
 * The store's blog (modules/blog, spec-gaps item 190): categories and posts.
 * A post's body is a list of blocks (headings, paragraphs, images, lists,
 * quotes, products, buttons) — never stored HTML.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('blog_categories', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      slug: { type: Sequelize.STRING(140), allowNull: false },
      description: { type: Sequelize.STRING(500), allowNull: true },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('blog_categories', ['workspace_id', 'slug'], { name: 'blog_categories_slug_unique', unique: true });
    await queryInterface.createTable('blog_posts', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      category_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'blog_categories', key: 'id' }, onDelete: 'SET NULL' },
      title: { type: Sequelize.STRING(200), allowNull: false },
      slug: { type: Sequelize.STRING(220), allowNull: false },
      excerpt: { type: Sequelize.STRING(500), allowNull: true },
      cover_url: { type: Sequelize.STRING(1000), allowNull: true },
      blocks: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      author_name: { type: Sequelize.STRING(120), allowNull: true },
      tags: { type: Sequelize.ARRAY(Sequelize.STRING(60)), allowNull: false, defaultValue: [] },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'draft' },
      published_at: { type: Sequelize.DATE, allowNull: true },
      seo: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      created_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('blog_posts', ['workspace_id', 'slug'], { name: 'blog_posts_slug_unique', unique: true });
    await queryInterface.addIndex('blog_posts', ['workspace_id', 'status', 'published_at'], { name: 'blog_posts_published_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('blog_posts');
    await queryInterface.dropTable('blog_categories');
  },
};
