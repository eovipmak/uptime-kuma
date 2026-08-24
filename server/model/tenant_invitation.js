const { BeanModel } = require("redbean-node/dist/bean-model");

/**
 * A pending single-use tenant invitation.
 * Maps to the `tenant_invitation` table created by db/knex_migrations/2026-08-23-0000-create-tenant-tables.js
 */
class TenantInvitation extends BeanModel {

}

module.exports = TenantInvitation;
