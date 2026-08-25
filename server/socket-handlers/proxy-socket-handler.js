const { checkLogin } = require("../util-server");
// G3 task-14: RBAC enforcement (see per-event annotations below)
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { Proxy } = require("../proxy");
const { sendProxyList } = require("../client");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const server = UptimeKumaServer.getInstance();

/**
 * Handlers for proxy
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.proxySocketHandler = (socket) => {
    socket.on("addProxy", async (proxy, proxyID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — proxy management is tenant_admin (task-13
            // matrix). Also covers edit: saving with an existing proxyID
            // updates the proxy. getProxyList has no socket event here — the
            // list is pushed to the caller after mutations.
            checkPermission(socket, PERMISSIONS.PROXY_MANAGE);

            const proxyBean = await Proxy.save(proxy, proxyID, socket.userID);
            await sendProxyList(socket);

            if (proxy.applyExisting) {
                await Proxy.reloadProxy();
                await server.sendMonitorList(socket);
            }

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: proxyBean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteProxy", async (proxyID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — proxy management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.PROXY_MANAGE);

            await Proxy.delete(proxyID, socket.userID);
            await sendProxyList(socket);
            await Proxy.reloadProxy();

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
};
