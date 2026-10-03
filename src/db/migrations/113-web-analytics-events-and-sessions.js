'use strict';

/**
 * Web analytics (ported from Umami, MIT): page-level columns on
 * analytics_events (visit, url path/query, hostname, title, referrer
 * domain/path, utm content/term, tag, currency, screen, language) plus a new
 * analytics_sessions table holding one row per (workspace, client session)
 * with browser/os/device/screen/language/geo and the session's current visit.
 *
 * Ported from the zimos-additions branch, where it was numbered 088; that
 * number is taken here (088-add-orders-search-indexes), so it runs as 113.
 * analytics_events itself is migration 048 (+ the dedupe index in 058).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    const str = (n) => ({ type: DataTypes.STRING(n), allowNull: true });

    await queryInterface.sequelize.transaction(async (transaction) => {
      const columns = {
        visit_id: str(64),
        event_type: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
        url_path: str(500),
        url_query: str(500),
        hostname: str(100),
        page_title: str(500),
        referrer_domain: str(500),
        referrer_path: str(500),
        utm_content: str(255),
        utm_term: str(255),
        tag: str(50),
        currency: str(3),
        screen: str(11),
        language: str(35),
      };
      for (const [name, def] of Object.entries(columns)) {
        await queryInterface.addColumn('analytics_events', name, def, { transaction });
      }
      // Anything written before this migration counts as a custom event unless
      // it is a page_view (Umami event_type 1 = pageview, 2 = custom event).
      await queryInterface.sequelize.query("UPDATE analytics_events SET event_type = 2 WHERE event_name <> 'page_view'", {
        transaction,
      });

      const eventIndexes = [
        ['workspace_id', 'created_at', 'url_path'],
        ['workspace_id', 'created_at', 'referrer_domain'],
        ['workspace_id', 'session_id', 'created_at'],
        ['workspace_id', 'visit_id', 'created_at'],
        ['workspace_id', 'event_type', 'created_at'],
      ];
      for (const fields of eventIndexes) {
        await queryInterface.addIndex('analytics_events', fields, {
          name: `analytics_events_${fields.join('_')}_idx`,
          transaction,
        });
      }

      await queryInterface.createTable(
        'analytics_sessions',
        {
          id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            primaryKey: true,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          website_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'websites', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          visitor_id: { type: DataTypes.STRING(64), allowNull: false },
          browser: str(20),
          os: str(20),
          device: str(20),
          screen: str(11),
          language: str(35),
          country: { type: DataTypes.CHAR(2), allowNull: true },
          region: str(20),
          city: str(50),
          current_visit_id: { type: DataTypes.STRING(64), allowNull: false },
          last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      for (const col of ['browser', 'os', 'device', 'country', 'language']) {
        await queryInterface.addIndex('analytics_sessions', ['workspace_id', 'created_at', col], {
          name: `analytics_sessions_workspace_id_created_at_${col}_idx`,
          transaction,
        });
      }
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('analytics_sessions', { transaction });
      const indexes = [
        'analytics_events_workspace_id_created_at_url_path_idx',
        'analytics_events_workspace_id_created_at_referrer_domain_idx',
        'analytics_events_workspace_id_session_id_created_at_idx',
        'analytics_events_workspace_id_visit_id_created_at_idx',
        'analytics_events_workspace_id_event_type_created_at_idx',
      ];
      for (const name of indexes) {
        await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${name}`, { transaction });
      }
      const cols = [
        'visit_id',
        'event_type',
        'url_path',
        'url_query',
        'hostname',
        'page_title',
        'referrer_domain',
        'referrer_path',
        'utm_content',
        'utm_term',
        'tag',
        'currency',
        'screen',
        'language',
      ];
      for (const c of cols) {
        await queryInterface.removeColumn('analytics_events', c, { transaction });
      }
    });
  },
};
