const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

class Proxy extends BeanModel {
    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this._id,
            userId: this._user_id,
            protocol: this._protocol,
            host: this._host,
            port: this._port,
            auth: !!this._auth,
            username: this._username,
            password: this._password,
            active: !!this._active,
            default: !!this._default,
            createdDate: this._created_date,
        };
    }

    /**
     * Tenant this proxy belongs to (G1 multi-tenant model)
     * @returns {number|null} tenant_id column value
     */
    get tenantId() {
        return this.tenant_id;
    }

    /**
     * List all proxies belonging to a tenant
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<object[]>} List of proxy rows ordered by id
     */
    static async listForTenant(tenantId) {
        return await R.getAll("SELECT * FROM proxy WHERE tenant_id = ? ORDER BY id", [tenantId]);
    }
}

module.exports = Proxy;
