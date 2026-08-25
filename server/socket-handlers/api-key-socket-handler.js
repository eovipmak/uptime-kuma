const { checkLogin } = require("../util-server");
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");
const passwordHash = require("../password-hash");
const apicache = require("../modules/apicache");
const APIKey = require("../model/api_key");
const { Settings } = require("../settings");
const { sendAPIKeyList } = require("../client");

/**
 * Handlers for API keys
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.apiKeySocketHandler = (socket) => {
    // Add a new api key
    socket.on("addAPIKey", async (key, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — API key management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.API_KEY_MANAGE);

            let clearKey = nanoid(40);
            let hashedKey = await passwordHash.generate(clearKey);
            key["key"] = hashedKey;
            let bean = await APIKey.save(key, socket.userID);

            log.debug("apikeys", "Added API Key");
            log.debug("apikeys", key);

            // Append key ID and prefix to start of key separated by _, used to get
            // correct hash when validating key.
            let formattedKey = "uk" + bean.id + "_" + clearKey;
            await sendAPIKeyList(socket);

            // Enable API auth if the user creates a key, otherwise only basic
            // auth will be used for API.
            await Settings.set("apiKeysEnabled", true);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                key: formattedKey,
                keyID: bean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getAPIKeyList", async (callback) => {
        try {
            checkLogin(socket);
            // RBAC: read, viewer+ OK (no check needed). Existing behavior shows the
            // key list to every logged-in member of the tenant (no admin-only
            // hiding), so per task-14 item 2 the read stays open.

            await sendAPIKeyList(socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("apikeys", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — API key management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.API_KEY_MANAGE);

            log.debug("apikeys", `Deleted API Key: ${keyID} User ID: ${socket.userID}`);

            await R.exec("DELETE FROM api_key WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("disableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — toggling key state is API key management (tenant_admin)
            checkPermission(socket, PERMISSIONS.API_KEY_MANAGE);

            log.debug("apikeys", `Disabled Key: ${keyID} User ID: ${socket.userID}`);

            await R.exec("UPDATE api_key SET active = 0 WHERE id = ? ", [keyID]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successDisabled",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("enableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — toggling key state is API key management (tenant_admin)
            checkPermission(socket, PERMISSIONS.API_KEY_MANAGE);

            log.debug("apikeys", `Enabled Key: ${keyID} User ID: ${socket.userID}`);

            await R.exec("UPDATE api_key SET active = 1 WHERE id = ? ", [keyID]);

            apicache.clear();

            callback({
                ok: true,
                msg: "successEnabled",
                msgi18n: true,
            });

            await sendAPIKeyList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
