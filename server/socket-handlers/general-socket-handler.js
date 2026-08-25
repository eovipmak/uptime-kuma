const { log } = require("../../src/util");
const { Settings } = require("../settings");
const { sendInfo } = require("../client");
const { checkLogin } = require("../util-server");
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { games } = require("gamedig");
const { testChrome } = require("../monitor-types/real-browser-monitor-type");
const { getPM2ProcessList } = require("../util/pm2");
const fsAsync = require("fs").promises;
const path = require("path");

/**
 * Get a game list via GameDig
 * @returns {object} list of games supported by GameDig
 */
function getGameList() {
    let gameList = [];
    gameList = Object.keys(games).map((key) => {
        const item = games[key];
        return {
            keys: [key],
            pretty: item.name,
            options: item.options,
            extra: item.extra || {},
        };
    });
    gameList.sort((a, b) => {
        if (a.pretty < b.pretty) {
            return -1;
        }
        if (a.pretty > b.pretty) {
            return 1;
        }
        return 0;
    });
    return gameList;
}

/**
 * Handler for general events
 * @param {Socket} socket Socket.io instance
 * @param {UptimeKumaServer} server Uptime Kuma server
 * @returns {void}
 */
module.exports.generalSocketHandler = (socket, server) => {
    socket.on("initServerTimezone", async (timezone) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — persists server-wide timezone settings
            // (Settings.set + server.setTimezone), so it needs tenant_admin.
            // Safe to gate: the server only asks the client for this after
            // afterLogin, so socket.role is always set here; first-run is the
            // default-tenant admin (G1 task-06).
            checkPermission(socket, PERMISSIONS.TENANT_SETTINGS_UPDATE);
            log.debug("generalSocketHandler", "Timezone: " + timezone);
            await Settings.set("initServerTimezone", true);
            await server.setTimezone(timezone);
            await sendInfo(socket);
        } catch (e) {
            log.warn("initServerTimezone", e.message);
        }
    });

    socket.on("getGameList", async (callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed).

            callback({
                ok: true,
                gameList: getGameList(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getPM2ProcessList", async (callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: admin-grade server diagnostic exposed on the settings
            // screen — gated like the other tenant-settings mutations per
            // task-14 item 1 (TENANT_SETTINGS_UPDATE, tenant_admin).
            checkPermission(socket, PERMISSIONS.TENANT_SETTINGS_UPDATE);

            callback({
                ok: true,
                processList: await getPM2ProcessList(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("testChrome", (executable, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: spawns a process from a caller-supplied executable
            // path — admin-grade server diagnostic on the settings screen,
            // gated like getPM2ProcessList per task-14 item 1
            // (TENANT_SETTINGS_UPDATE, tenant_admin).
            checkPermission(socket, PERMISSIONS.TENANT_SETTINGS_UPDATE);

            // Just noticed that await call could block the whole socket.io server!!! Use pure promise instead.
            testChrome(executable)
                .then((version) => {
                    callback({
                        ok: true,
                        msg: {
                            key: "foundChromiumVersion",
                            values: [version],
                        },
                        msgi18n: true,
                    });
                })
                .catch((e) => {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getPushExample", async (language, callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed) — returns bundled push
            // example source from extra/push-examples.

            if (!/^[a-z-]+$/.test(language)) {
                throw new Error("Invalid language");
            }
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
            return;
        }

        try {
            let dir = path.join("./extra/push-examples", language);
            let files = await fsAsync.readdir(dir);

            for (let file of files) {
                if (file.startsWith("index.")) {
                    callback({
                        ok: true,
                        code: await fsAsync.readFile(path.join(dir, file), "utf8"),
                    });
                    return;
                }
            }
        } catch (e) {}

        callback({
            ok: false,
            msg: "Not found",
        });
    });

    // Disconnect all other socket clients of the user
    socket.on("disconnectOtherSocketClients", async () => {
        try {
            checkLogin(socket);
            // RBAC: deliberately not gated (self-service) — "log out my other
            // sessions" acts only on sockets of the calling user themselves
            // (socket.userID, excluding socket.id), never on another user's or
            // the tenant's resources. Same rationale as changePassword/2FA.
            server.disconnectAllSocketClients(socket.userID, socket.id);
        } catch (e) {
            log.warn("disconnectAllSocketClients", e.message);
        }
    });
};
