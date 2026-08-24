const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

class Tag extends BeanModel {
    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this._id,
            name: this._name,
            color: this._color,
        };
    }

    /**
     * Tenant this tag belongs to (G1 multi-tenant model)
     * @returns {number|null} tenant_id column value
     */
    get tenantId() {
        return this.tenant_id;
    }

    /**
     * List all tags belonging to a tenant
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<Bean[]>} List of tag beans ordered by id
     */
    static async listForTenant(tenantId) {
        return await R.findMany("tag", " tenant_id = ? ORDER BY id ", [tenantId]);
    }
}

module.exports = Tag;
