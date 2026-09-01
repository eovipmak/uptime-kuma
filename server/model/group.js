const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");

class Group extends BeanModel {
    /**
     * Return an object that ready to parse to JSON for public Only show
     * necessary data to public
     * @param {boolean} showTags Should the JSON include monitor tags
     * @param {boolean} certExpiry Should JSON include info about
     * certificate expiry?
     * @param {number} tenantId Tenant ID scoping the data
     * @returns {Promise<object>} Object ready to parse
     */
    async toPublicJSON(showTags = false, certExpiry = false, tenantId = null) {
        let monitorBeanList = await this.getMonitorList(tenantId);
        let monitorList = [];

        for (let bean of monitorBeanList) {
            monitorList.push(await bean.toPublicJSON(showTags, certExpiry));
        }

        return {
            id: this.id,
            name: this.name,
            weight: this.weight,
            monitorList,
        };
    }

    /**
     * Get all monitors
     * @param {number} tenantId Tenant ID scoping the monitors
     * @returns {Promise<Bean[]>} List of monitors
     */
    async getMonitorList(tenantId) {
        if (tenantId == null) {
            return R.convertToBeans(
                "monitor",
                await R.getAll(
                    `
                SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url FROM monitor, monitor_group
                WHERE monitor.id = monitor_group.monitor_id
                AND group_id = ?
                ORDER BY monitor_group.weight
            `,
                    [this.id]
                )
            );
        }
        return R.convertToBeans(
            "monitor",
            await R.getAll(
                `
            SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url FROM monitor, monitor_group
            WHERE monitor.id = monitor_group.monitor_id
            AND group_id = ?
            AND monitor.tenant_id = ?
            ORDER BY monitor_group.weight
        `,
                [this.id, tenantId]
            )
        );
    }

    /**
     * Tenant this group belongs to (G1 multi-tenant model)
     * @returns {number|null} tenant_id column value
     */
    get tenantId() {
        return this.tenant_id;
    }

    /**
     * List all groups belonging to a tenant
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<object[]>} List of group rows ordered by id
     */
    static async listForTenant(tenantId) {
        return await R.getAll("SELECT * FROM `group` WHERE tenant_id = ? ORDER BY id", [tenantId]);
    }
}

module.exports = Group;
