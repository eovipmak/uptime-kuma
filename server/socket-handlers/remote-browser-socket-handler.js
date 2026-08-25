const { sendRemoteBrowserList } = require("../client");
const { checkLogin } = require("../util-server");
// G3 task-14: RBAC enforcement (see per-event annotations below)
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { RemoteBrowser } = require("../remote-browser");

const { log } = require("../../src/util");
const { testRemoteBrowser } = require("../monitor-types/real-browser-monitor-type");

/**
 * Handlers for docker hosts
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.remoteBrowserSocketHandler = (socket) => {
    socket.on("addRemoteBrowser", async (remoteBrowser, remoteBrowserID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — tenant-operational resource. Task-14 item
            // 7: no dedicated permission in the frozen task-13 enum, so gate on
            // TENANT_SETTINGS_UPDATE (tenant_admin). Also covers edit (existing
            // remoteBrowserID updates the entry).
            checkPermission(socket, PERMISSIONS.TENANT_SETTINGS_UPDATE);

            let remoteBrowserBean = await RemoteBrowser.save(remoteBrowser, remoteBrowserID, socket.userID);
            await sendRemoteBrowserList(socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: remoteBrowserBean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteRemoteBrowser", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — TENANT_SETTINGS_UPDATE per task-14 item 7
            // (see addRemoteBrowser annotation).
            checkPermission(socket, PERMISSIONS.TENANT_SETTINGS_UPDATE);

            await RemoteBrowser.delete(dockerHostID, socket.userID);
            await sendRemoteBrowserList(socket);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("testRemoteBrowser", async (remoteBrowser, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: connectivity probe against a caller-supplied remote
            // browser URL — admin-grade diagnostic on the same domain, gated
            // like the other remote-browser mutations (TENANT_SETTINGS_UPDATE,
            // task-14 item 7).
            checkPermission(socket, PERMISSIONS.TENANT_SETTINGS_UPDATE);

            let check = await testRemoteBrowser(remoteBrowser.url);
            log.info("remoteBrowser", "Tested remote browser: " + check);
            let msg;

            if (check) {
                msg = "Connected Successfully.";
            }

            callback({
                ok: true,
                msg,
            });
        } catch (e) {
            log.error("remoteBrowser", e);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
