const { checkLogin } = require("../util-server");
// G3 task-14: RBAC enforcement (see per-event annotations below)
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
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

            let bean = await Maintenance.jsonToBean(R.dispense("maintenance"), maintenance);
            bean.user_id = socket.userID;
            let maintenanceID = await R.store(bean);

            server.maintenanceList[maintenanceID] = bean;
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

            let bean = server.getMaintenance(maintenance.id);

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

            await R.exec("DELETE FROM monitor_maintenance WHERE maintenance_id = ?", [maintenanceID]);

            for await (const monitor of monitors) {
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

            await R.exec("DELETE FROM maintenance_status_page WHERE maintenance_id = ?", [maintenanceID]);

            for await (const statusPage of statusPages) {
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

            let bean = await R.findOne("maintenance", " id = ? AND user_id = ? ", [maintenanceID, socket.userID]);

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

            let monitors = await R.getAll(
                "SELECT monitor.id FROM monitor_maintenance mm JOIN monitor ON mm.monitor_id = monitor.id WHERE mm.maintenance_id = ? ",
                [maintenanceID]
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

            let statusPages = await R.getAll(
                "SELECT status_page.id, status_page.title FROM maintenance_status_page msp JOIN status_page ON msp.status_page_id = status_page.id WHERE msp.maintenance_id = ? ",
                [maintenanceID]
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

            await R.exec("DELETE FROM maintenance WHERE id = ? AND user_id = ? ", [maintenanceID, socket.userID]);

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

            let maintenance = server.getMaintenance(maintenanceID);

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

            let maintenance = server.getMaintenance(maintenanceID);

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
