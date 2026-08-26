const { sendDockerHostList } = require("../client");
const { checkLogin } = require("../util-server");
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
const { DockerHost } = require("../docker");
const { log } = require("../../src/util");

/**
 * Handlers for docker hosts
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.dockerSocketHandler = (socket) => {
    socket.on("addDockerHost", async (dockerHost, dockerHostID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — Docker host management is tenant_admin
            // (task-13 matrix). Also covers edit: saving with an existing
            // dockerHostID updates the host.
            checkPermission(socket, PERMISSIONS.DOCKER_HOST_MANAGE);

            // G4.21: thread the caller's active tenant so the row is born in
            // (or looked up within) the right tenant, not the default fallback
            let dockerHostBean = await DockerHost.save(dockerHost, dockerHostID, socket.userID, socket.tenantID);
            await sendDockerHostList(socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: dockerHostBean.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteDockerHost", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — Docker host management is tenant_admin (task-13 matrix)
            checkPermission(socket, PERMISSIONS.DOCKER_HOST_MANAGE);

            // G4.21: tenant-scoped delete — see addDockerHost above
            await DockerHost.delete(dockerHostID, socket.userID, socket.tenantID);
            await sendDockerHostList(socket);

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

    socket.on("testDockerHost", async (dockerHost, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: connectivity test with Docker-host credentials against
            // a caller-supplied target — an admin-grade diagnostic on the docker
            // host domain, so it is gated like the other host mutations instead
            // of being left as a viewer-readable probe.
            checkPermission(socket, PERMISSIONS.DOCKER_HOST_MANAGE);

            let amount = await DockerHost.testDockerHost(dockerHost);
            let msg;

            if (amount >= 1) {
                msg = "Connected Successfully. Amount of containers: " + amount;
            } else {
                msg = "Connected Successfully, but there are no containers?";
            }

            callback({
                ok: true,
                msg,
            });
        } catch (e) {
            log.error("docker", e);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
