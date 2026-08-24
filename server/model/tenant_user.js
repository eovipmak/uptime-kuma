const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

/**
 * Membership of a user in a tenant (N-N join).
 * Maps to the `tenant_user` table created by db/knex_migrations/2026-08-23-0000-create-tenant-tables.js
 */
class TenantUser extends BeanModel {
    /**
     * List all tenants that the given user belongs to.
     * SQL: SELECT t.*, tu.role FROM tenant_user tu JOIN tenant t ON t.id = tu.tenant_id WHERE tu.user_id = ?
     * The membership role is included (no name collision: the tenant table has no role column).
     * Consumed by G2 for the post-login tenant picker and resolveTenant() middleware.
     * @param {number} userId ID of the user
     * @returns {Promise<object[]>} List of tenant rows the user has membership in, each with `role` from tenant_user
     */
    static async listForUser(userId) {
        return await R.getAll("SELECT t.*, tu.role FROM tenant_user tu JOIN tenant t ON t.id = tu.tenant_id WHERE tu.user_id = ? ", [
            userId,
        ]);
    }
}

module.exports = TenantUser;
