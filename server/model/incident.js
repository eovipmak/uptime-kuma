const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");
const dayjs = require("dayjs");

class Incident extends BeanModel {
    /**
     * Resolve the incident and mark it as inactive
     * @returns {Promise<void>}
     */
    async resolve() {
        this.active = false;
        this.pin = false;
        this.last_updated_date = R.isoDateTime(dayjs.utc());
        await R.store(this);
    }

    /**
     * Return an object that ready to parse to JSON for public
     * @param {number} tenantId Tenant ID scoping the data (identity for API consistency)
     * @returns {object} Object ready to parse
     */
    toPublicJSON(tenantId = null) {
        return {
            id: this.id,
            style: this.style,
            title: this.title,
            content: this.content,
            pin: !!this.pin,
            active: !!this.active,
            createdDate: this.created_date,
            lastUpdatedDate: this.last_updated_date,
            status_page_id: this.status_page_id,
        };
    }

    /**
     * Tenant derived getter: incidents have no tenant_id column, they inherit
     * tenancy through their status page anchor (see docs/architecture/erd-to-be.md).
     * Kept for API consistency with the other models; always returns null.
     * @returns {null} Incidents are tenant-scoped via their status page
     */
    get tenantId() {
        return null;
    }

    /**
     * List all incidents belonging to a tenant (resolved through the
     * status page anchor, as incident rows carry no tenant_id column)
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<Bean[]>} List of incident beans ordered by id
     */
    static async listForTenant(tenantId) {
        return await R.getAll(
            "SELECT incident.* FROM incident, status_page WHERE incident.status_page_id = status_page.id AND status_page.tenant_id = ? ORDER BY incident.id",
            [tenantId]
        );
    }
}

module.exports = Incident;
