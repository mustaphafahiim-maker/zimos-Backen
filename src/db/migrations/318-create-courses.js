'use strict';

/**
 * Courses (SPEC §18.3).
 *
 *   courses          a course, optionally sold through one product.
 *   course_modules   its chapters, in order.
 *   lessons          video (an external player link), text or a file from the
 *                    file library; a lesson can be a free preview and can be
 *                    released N days after enrollment (drip).
 *   enrollments      a customer's access to a course, from a paid order or
 *                    granted by the merchant.
 *   lesson_progress  the lessons a student finished.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false };
    const ref = (model, onDelete = 'CASCADE', allowNull = false) => ({
      type: DataTypes.UUID,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('courses', {
      id,
      workspace_id: ref('workspaces'),
      product_id: ref('products', 'SET NULL', true),
      title: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      cover_url: { type: DataTypes.STRING(1000), allowNull: true },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'draft' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(`ALTER TABLE courses ADD CONSTRAINT courses_status_check CHECK (status IN ('draft', 'published'))`);
    await queryInterface.addIndex('courses', ['workspace_id', 'slug'], { unique: true, name: 'courses_ws_slug_uq' });
    await queryInterface.addIndex('courses', ['product_id'], { name: 'courses_product_idx' });

    await queryInterface.createTable('course_modules', {
      id,
      course_id: ref('courses'),
      title: { type: DataTypes.STRING(200), allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('course_modules', ['course_id', 'position'], { name: 'course_modules_course_idx' });

    await queryInterface.createTable('lessons', {
      id,
      course_id: ref('courses'),
      module_id: ref('course_modules'),
      title: { type: DataTypes.STRING(200), allowNull: false },
      kind: { type: DataTypes.STRING(10), allowNull: false },
      video_url: { type: DataTypes.STRING(1000), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: true },
      file_id: ref('digital_files', 'SET NULL', true),
      duration_seconds: { type: DataTypes.INTEGER, allowNull: true },
      is_free_preview: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      drip_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(`ALTER TABLE lessons ADD CONSTRAINT lessons_kind_check CHECK (kind IN ('video', 'text', 'file'))`);
    await queryInterface.addIndex('lessons', ['module_id', 'position'], { name: 'lessons_module_idx' });

    await queryInterface.createTable('enrollments', {
      id,
      workspace_id: ref('workspaces'),
      course_id: ref('courses'),
      customer_id: ref('customers'),
      order_id: ref('orders', 'SET NULL', true),
      source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'order' },
      enrolled_at: now,
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('enrollments', ['course_id', 'customer_id'], { unique: true, name: 'enrollments_course_customer_uq' });
    await queryInterface.addIndex('enrollments', ['workspace_id', 'customer_id'], { name: 'enrollments_ws_customer_idx' });

    await queryInterface.createTable('lesson_progress', {
      id,
      enrollment_id: ref('enrollments'),
      lesson_id: ref('lessons'),
      completed_at: now,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('lesson_progress', ['enrollment_id', 'lesson_id'], { unique: true, name: 'lesson_progress_uq' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('lesson_progress');
    await queryInterface.dropTable('enrollments');
    await queryInterface.dropTable('lessons');
    await queryInterface.dropTable('course_modules');
    await queryInterface.dropTable('courses');
  },
};
