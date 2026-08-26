const { checkLogin } = require("../util-server");
// G3 task-14: RBAC enforcement (see per-event annotations below)
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
// G4.18 (KUM-34): tenant-safe query wrappers
const { findOneForTenant, execForTenant, dispenseForTenant } = require("../repository");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const Maintenance = require("../model/maintenance");
const server = UptimeKumaServer.getInstance();

/**
 * Handlers for Maintenance
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.maintenanceSocketHandler = (socket) => {
    // Add a new maintenance
    socket.on("addMaintenance", async (maintenance, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — maintenance management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            log.debug("maintenance", maintenance);

            // G4.18: born into the caller's tenant
            let bean = await Maintenance.jsonToBean(dispenseForTenant("maintenance", socket.tenantID), maintenance);
            bean.user_id = socket.userID;
            let maintenanceID = await R.store(bean);

            server.maintenanceList[maintenanceID] = bean;
            // G4.21: keep the tenant-partitioned map in sync too — without it
            // the new entry is invisible to getMaintenanceJSONList emits and
            // tenant-scoped lookups until the next full loadMaintenanceList()
            if (!server.maintenanceListByTenant[socket.tenantID]) {
                server.maintenanceListByTenant[socket.tenantID] = {};
            }
            server.maintenanceListByTenant[socket.tenantID][maintenanceID] = bean;
            await bean.run(true);

            await server.sendMaintenanceList(socket);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                maintenanceID,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Edit a maintenance
    socket.on("editMaintenance", async (maintenance, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — maintenance management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            // G4.21: tenant-scoped lookup — the legacy flat map is keyed by id
            // alone, so a multi-tenant user could edit their own row living in
            // another active tenant (G4.20 IDOR finding)
            let bean = server.getMaintenanceForTenant(maintenance.id, socket.tenantID);

            if (!bean) {
                throw new Error("Maintenance not found");
            }

            if (bean.user_id !== socket.userID) {
                throw new Error("Permission denied.");
            }

            await Maintenance.jsonToBean(bean, maintenance);
            await R.store(bean);
            await bean.run(true);
            await server.sendMaintenanceList(socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                maintenanceID: bean.id,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Add a new monitor_maintenance
    socket.on("addMonitorMaintenance", async (maintenanceID, monitors, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — rewires the monitor↔maintenance join rows.
            // Not enumerated individually in task-14, but it is a maintenance-
            // domain write; MAINTENANCE_MANAGE is the matching constant from the
            // frozen task-13 enum (no new permission invented).
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            // G4.18: verify the maintenance belongs to the caller's tenant
            // before touching its junction rows (maintenance_id is client input)
            const maintenanceBean = await findOneForTenant("maintenance", " id = ? AND user_id = ? ", [
                maintenanceID,
                socket.userID,
            ], socket.tenantID);
            if (maintenanceBean == null) {
                throw new Error("Maintenance not found or access denied.");
            }

            // G4.18: junction rows are parent-anchored (ADR-0002); the IN-subquery
            // pins the delete to maintenance rows of the caller's tenant
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- monitor_maintenance has no tenant_id column (ADR-0002); rows pinned via IN-subquery on maintenance.tenant_id
            await R.exec(
                "DELETE FROM monitor_maintenance WHERE maintenance_id = ? " +
                "AND maintenance_id IN (SELECT id FROM maintenance WHERE tenant_id = ?)", [
                    maintenanceID,
                    socket.tenantID,
                ]
            );

            for await (const monitor of monitors) {
                // G4.18 defense-in-depth: refuse to wire a monitor from another tenant
                const monitorBean = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                    monitor.id,
                    socket.userID,
                ], socket.tenantID);
                if (monitorBean == null) {
                    throw new Error("Monitor not found or access denied.");
                }
                // G4.18 exemption: parent-anchored junction (ADR-0002); both parents verified above
                let bean = R.dispense("monitor_maintenance");

                bean.import({
                    monitor_id: monitor.id,
                    maintenance_id: maintenanceID,
                });
                await R.store(bean);
            }

            apicache.clear();

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Add a new monitor_maintenance
    socket.on("addMaintenanceStatusPage", async (maintenanceID, statusPages, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — rewires the maintenance↔status-page join
            // rows. Maintenance-domain management → MAINTENANCE_MANAGE (see
            // addMonitorMaintenance annotation).
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            // G4.18: verify the maintenance belongs to the caller's tenant
            const maintenanceBean = await findOneForTenant("maintenance", " id = ? AND user_id = ? ", [
                maintenanceID,
                socket.userID,
            ], socket.tenantID);
            if (maintenanceBean == null) {
                throw new Error("Maintenance not found or access denied.");
            }

            // G4.18: junction rows are parent-anchored (ADR-0002); the IN-subquery
            // pins the delete to maintenance rows of the caller's tenant
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- maintenance_status_page has no tenant_id column (ADR-0002); rows pinned via IN-subquery on maintenance.tenant_id
            await R.exec(
                "DELETE FROM maintenance_status_page WHERE maintenance_id = ? " +
                "AND maintenance_id IN (SELECT id FROM maintenance WHERE tenant_id = ?)", [
                    maintenanceID,
                    socket.tenantID,
                ]
            );

            for await (const statusPage of statusPages) {
                // G4.18 defense-in-depth: refuse to wire a foreign tenant's status page
                const statusPageBean = await findOneForTenant("status_page", " id = ? ", [
                    statusPage.id,
                ], socket.tenantID);
                if (statusPageBean == null) {
                    throw new Error("Status Page not found or access denied.");
                }
                // G4.18 exemption: parent-anchored junction (ADR-0002); both parents verified above
                let bean = R.dispense("maintenance_status_page");

                bean.import({
                    status_page_id: statusPage.id,
                    maintenance_id: maintenanceID,
                });
                await R.store(bean);
            }

            apicache.clear();

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed).

            log.debug("maintenance", `Get Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            // G4.18: tenant+user scoped lookup
            let bean = await findOneForTenant("maintenance", " id = ? AND user_id = ? ", [
                maintenanceID,
                socket.userID,
            ], socket.tenantID);

            callback({
                ok: true,
                maintenance: await bean.toJSON(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenanceList", async (callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed).

            await server.sendMaintenanceList(socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMonitorMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed).

            log.debug("maintenance", `Get Monitors for Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            // G4.18: the maintenance anchor is restricted to the caller's tenant
            let monitors = await R.getAll(
                "SELECT monitor.id FROM monitor_maintenance mm JOIN monitor ON mm.monitor_id = monitor.id " +
                "WHERE mm.maintenance_id = ? AND mm.maintenance_id IN (SELECT id FROM maintenance WHERE tenant_id = ?) ",
                [maintenanceID, socket.tenantID]
            );

            callback({
                ok: true,
                monitors,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenanceStatusPage", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed).

            log.debug("maintenance", `Get Status Pages for Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            // G4.18: the maintenance anchor is restricted to the caller's tenant
            let statusPages = await R.getAll(
                "SELECT status_page.id, status_page.title FROM maintenance_status_page msp " +
                "JOIN status_page ON msp.status_page_id = status_page.id WHERE msp.maintenance_id = ? " +
                "AND msp.maintenance_id IN (SELECT id FROM maintenance WHERE tenant_id = ?) ",
                [maintenanceID, socket.tenantID]
            );

            callback({
                ok: true,
                statusPages,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — maintenance management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            log.debug("maintenance", `Delete Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            if (maintenanceID in server.maintenanceList) {
                server.maintenanceList[maintenanceID].stop();
                delete server.maintenanceList[maintenanceID];
            }

            // G4.18: tenant+user scoped delete
            await execForTenant("DELETE FROM maintenance WHERE id = ? AND user_id = ? ", [
                maintenanceID,
                socket.userID,
            ], socket.tenantID);

            apicache.clear();

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });

            await server.sendMaintenanceList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("pauseMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — maintenance management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            log.debug("maintenance", `Pause Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            // G4.21: tenant-scoped lookup — see editMaintenance
            let maintenance = server.getMaintenanceForTenant(maintenanceID, socket.tenantID);

            if (!maintenance) {
                throw new Error("Maintenance not found");
            }

            maintenance.active = false;
            await R.store(maintenance);
            maintenance.stop();

            apicache.clear();

            callback({
                ok: true,
                msg: "successPaused",
                msgi18n: true,
            });

            await server.sendMaintenanceList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("resumeMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — maintenance management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);

            log.debug("maintenance", `Resume Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            // G4.21: tenant-scoped lookup — see editMaintenance
            let maintenance = server.getMaintenanceForTenant(maintenanceID, socket.tenantID);

            if (!maintenance) {
                throw new Error("Maintenance not found");
            }

            maintenance.active = true;
            await R.store(maintenance);
            await maintenance.run();

            apicache.clear();

            callback({
                ok: true,
                msg: "successResumed",
                msgi18n: true,
            });

            await server.sendMaintenanceList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
