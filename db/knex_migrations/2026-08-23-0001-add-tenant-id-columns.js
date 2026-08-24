// G1.05 — tenant_id Columns + Composite Indexes on Existing Tables
// Contract: docs/architecture/migration-contract.md — Clause B (tables gaining tenant_id)
// Adds nullable tenant_id FK column to ten business tables plus composite indexes.
// Knex methods only (no raw SQL) so both SQLite and MariaDB dialects work.

exports.up = function (knex) {
    return knex.schema
        // 1. monitor
        .alterTable("monitor", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            // Composite indexes per ADR-0002
            table.index(["tenant_id", "id"], "monitor_tenant_id_id_index");
            table.index(["tenant_id", "user_id"], "monitor_tenant_id_user_id_index");
        })
        // 2. group
        .alterTable("group", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "group_tenant_id_id_index");
        })
        // 3. proxy
        .alterTable("proxy", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "proxy_tenant_id_id_index");
        })
        // 4. docker_host
        .alterTable("docker_host", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "docker_host_tenant_id_id_index");
        })
        // 5. notification
        .alterTable("notification", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "notification_tenant_id_id_index");
        })
        // 6. status_page
        .alterTable("status_page", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "status_page_tenant_id_id_index");
        })
        // 7. maintenance
        .alterTable("maintenance", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "maintenance_tenant_id_id_index");
        })
        // 8. api_key
        .alterTable("api_key", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "api_key_tenant_id_id_index");
        })
        // 9. tag
        .alterTable("tag", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "tag_tenant_id_id_index");
        })
        // 10. remote_browser
        .alterTable("remote_browser", function (table) {
            table
                .integer("tenant_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.index(["tenant_id", "id"], "remote_browser_tenant_id_id_index");
        });
};

exports.down = function (knex) {
    return knex.schema
        // Remove in reverse order
        .alterTable("remote_browser", function (table) {
            table.dropIndex([], "remote_browser_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("tag", function (table) {
            table.dropIndex([], "tag_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("api_key", function (table) {
            table.dropIndex([], "api_key_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("maintenance", function (table) {
            table.dropIndex([], "maintenance_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("status_page", function (table) {
            table.dropIndex([], "status_page_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("notification", function (table) {
            table.dropIndex([], "notification_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("docker_host", function (table) {
            table.dropIndex([], "docker_host_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("proxy", function (table) {
            table.dropIndex([], "proxy_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("group", function (table) {
            table.dropIndex([], "group_tenant_id_id_index");
            table.dropColumn("tenant_id");
        })
        .alterTable("monitor", function (table) {
            table.dropIndex([], "monitor_tenant_id_user_id_index");
            table.dropIndex([], "monitor_tenant_id_id_index");
            table.dropColumn("tenant_id");
        });
};
