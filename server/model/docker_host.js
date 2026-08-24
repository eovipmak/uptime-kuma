const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

class DockerHost extends BeanModel {
    /**
     * Returns an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            userID: this.user_id,
            dockerDaemon: this.docker_daemon,
            dockerType: this.docker_type,
            name: this.name,
        };
    }

    /**
     * Tenant this docker host belongs to (G1 multi-tenant model)
     * @returns {number|null} tenant_id column value
     */
    get tenantId() {
        return this.tenant_id;
    }

    /**
     * List all docker hosts belonging to a tenant
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<Bean[]>} List of docker host beans ordered by id
     */
    static async listForTenant(tenantId) {
        return await R.findMany("docker_host", " tenant_id = ? ORDER BY id ", [tenantId]);
    }
}

module.exports = DockerHost;
