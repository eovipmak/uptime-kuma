const { checkLogin } = require("../util-server");
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const Database = require("../database");

/**
 * Handlers for database
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.databaseSocketHandler = (socket) => {
    // Post or edit incident
    socket.on("getDatabaseSize", async (callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed).

            callback({
                ok: true,
                size: await Database.getSize(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("shrinkDatabase", async (callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — destructive database housekeeping. Task-14
            // item 8 maps this family (clear/clear/shrink) onto MONITOR_DELETE
            // ("treating heartbeat-clear as a destructive mutation; tenant_admin"),
            // which is the closest equivalent in the frozen task-13 enum.
            checkPermission(socket, PERMISSIONS.MONITOR_DELETE);

            await Database.shrink();
            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
};
