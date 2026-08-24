// G1.04 — Tenant Schema Foundation
// Contract: docs/architecture/migration-contract.md — Clause A (new tables)
// Creates the three tenant-root tables: tenant, tenant_user, tenant_invitation.
// Knex methods only (no raw SQL) so both SQLite and MariaDB dialects work.

exports.up = function (knex) {
    return knex.schema
        .createTable("tenant", function (table) {
            table.increments("id");
            table.string("name", 255).notNullable();
            table.string("slug", 255).notNullable().unique();
            table.string("plan", 255).defaultTo("free");
            table.string("status", 255).defaultTo("active");
            table.string("custom_domain", 255);

            // Non-unique index for the routing lookup in G2/G6
            table.index("custom_domain", "tenant_custom_domain_index");

            table.datetime("created_at").defaultTo(knex.fn.now());
            table.datetime("updated_at").defaultTo(knex.fn.now());
        })
        .createTable("tenant_user", function (table) {
            table.increments("id");
            table
                .integer("tenant_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("tenant")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");
            table
                .integer("user_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("user")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");
            table.string("role", 255).notNullable().defaultTo("viewer");
            table.datetime("joined_at").defaultTo(knex.fn.now());

            // A user appears at most once per tenant
            table.unique(["tenant_id", "user_id"]);
        })
        .createTable("tenant_invitation", function (table) {
            table.increments("id");
            table.integer("tenant_id").unsigned().notNullable().references("id").inTable("tenant").onDelete("CASCADE");
            table.string("email", 255).notNullable();
            table.string("token", 255).notNullable().unique();
            table.string("role", 255).notNullable().defaultTo("viewer");
            table.integer("invited_by_user_id").unsigned().references("id").inTable("user").onDelete("SET NULL");
            table.datetime("expires_at").notNullable();
            table.datetime("accepted_at");

            // Non-unique index to find pending invites per tenant
            table.index(["tenant_id", "email"], "tenant_invitation_tenant_id_email_index");
        });
};

exports.down = function (knex) {
    // Drop in reverse-FK order: invitation → membership → tenant
    return knex.schema.dropTable("tenant_invitation").dropTable("tenant_user").dropTable("tenant");
};
