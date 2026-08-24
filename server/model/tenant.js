const { BeanModel } = require("redbean-node/dist/bean-model");

/**
 * A tenant (workspace) — root entity of the multi-tenant isolation model.
 * Maps to the `tenant` table created by db/knex_migrations/2026-08-23-0000-create-tenant-tables.js
 */
class Tenant extends BeanModel {

}

module.exports = Tenant;
