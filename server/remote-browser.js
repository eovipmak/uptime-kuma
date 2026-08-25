const { R } = require("redbean-node");
const { findOneForTenant, dispenseForTenant, execForTenant, resolveTenantId } = require("./repository/tenant-repo");

class RemoteBrowser {
    /**
     * Gets remote browser from ID
     * @param {number} remoteBrowserID ID of the remote browser
     * @param {number} userID ID of the user who created the remote browser
     * @param {number|null} tenantId Active tenant of the caller (G4.19). When
     * omitted, falls back to the seeded default tenant so legacy in-process
     * callers keep working (logged, never silent).
     * @returns {Promise<Bean>} Remote Browser
     */
    static async get(remoteBrowserID, userID, tenantId = null) {
        const scopedTenantId = await resolveTenantId(tenantId, "RemoteBrowser.get");
        let bean = await findOneForTenant("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID], scopedTenantId);

        if (!bean) {
            throw new Error("Remote browser not found");
        }

        return bean;
    }

    /**
     * Save a Remote Browser
     * @param {object} remoteBrowser Remote Browser to save
     * @param {?number} remoteBrowserID ID of the Remote Browser to update
     * @param {number} userID ID of the user who adds the Remote Browser
     * @param {number|null} tenantId Active tenant of the caller (G4.19); see get()
     * @returns {Promise<Bean>} Updated Remote Browser
     */
    static async save(remoteBrowser, remoteBrowserID, userID, tenantId = null) {
        const scopedTenantId = await resolveTenantId(tenantId, "RemoteBrowser.save");
        let bean;

        if (remoteBrowserID) {
            bean = await findOneForTenant("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID], scopedTenantId);

            if (!bean) {
                throw new Error("Remote browser not found");
            }
        } else {
            bean = dispenseForTenant("remote_browser", scopedTenantId);
        }

        bean.user_id = userID;
        bean.name = remoteBrowser.name;
        bean.url = remoteBrowser.url;

        await R.store(bean);

        return bean;
    }

    /**
     * Delete a Remote Browser
     * @param {number} remoteBrowserID ID of the Remote Browser to delete
     * @param {number} userID ID of the user who created the Remote Browser
     * @param {number|null} tenantId Active tenant of the caller (G4.19); see get()
     * @returns {Promise<void>}
     */
    static async delete(remoteBrowserID, userID, tenantId = null) {
        const scopedTenantId = await resolveTenantId(tenantId, "RemoteBrowser.delete");
        let bean = await findOneForTenant("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID], scopedTenantId);

        if (!bean) {
            throw new Error("Remote Browser not found");
        }

        // Delete removed remote browser from monitors if exists. Multi-row by
        // design: every monitor referencing this browser is unlinked, scoped.
        await execForTenant("UPDATE monitor SET remote_browser = null WHERE remote_browser = ?", [remoteBrowserID], scopedTenantId, {
            requireId: false,
        });

        await R.trash(bean);
    }
}

module.exports = {
    RemoteBrowser,
};
