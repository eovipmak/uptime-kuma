const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

/**
 * Membership of a user in a tenant (N-N join).
 * Maps to the `tenant_user` table created by db/knex_migrations/2026-08-23-0000-create-tenant-tables.js
 */
class TenantUser extends BeanModel {
    /**
     * List all tenants that the given user belongs to, with their role.
     * Returns [{ id, name, slug, plan, status, role }]
     * Consumed by G2 for the post-login tenant picker and resolveTenant() middleware.
     * @param {number} userId ID of the user
     * @returns {Promise<object[]>} List of tenant rows with role the user has membership in
     */
    static async listForUser(userId) {
        return await R.getAll(
            "SELECT t.id, t.name, t.slug, t.plan, t.status, tu.role FROM tenant_user tu JOIN tenant t ON t.id = tu.tenant_id WHERE tu.user_id = ? ",
            [userId]
        );
    }

    /**
     * Get a specific membership record for a user in a tenant.
     * @param {number} userId ID of the user
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<object|null>} Membership row { tenant_id, user_id, role } or null
     */
    static async getMembership(userId, tenantId) {
        return await R.findOne(
            "tenant_user",
            " user_id = ? AND tenant_id = ? ",
            [userId, tenantId]
        );
    }
}

module.exports = TenantUser;
