const { BeanModel } = require("redbean-node/dist/bean-model");
const passwordHash = require("../password-hash");
const { R } = require("redbean-node");
const jwt = require("jsonwebtoken");
const { shake256, SHAKE256_LENGTH } = require("../util-server");

class User extends BeanModel {
    /**
     * Reset user password
     * Fix #1510, as in the context reset-password.js, there is no auto model mapping. Call this static function instead.
     * @param {number} userID ID of user to update
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    static async resetPassword(userID, newPassword) {
        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- user is global; tenancy enforced via tenant_user join (task-19 exemption contract)
        await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
            await passwordHash.generate(newPassword),
            userID,
        ]);
    }

    /**
     * Reset this users password
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    async resetPassword(newPassword) {
        const hashedPassword = await passwordHash.generate(newPassword);

        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- user is global; tenancy enforced via tenant_user join (task-19 exemption contract)
        await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [hashedPassword, this.id]);

        this.password = hashedPassword;
    }

    /**
     * Create a new JWT for a user.
     *
     * Claim contract frozen by G2 kanban task-09 (CTO ruling 2026-08-25):
     * `{ username, h, tid, role }`. Later phases may add claims only — never
     * rename or remove these fields. Signed with the existing server.jwtSecret;
     * no expiry change in this phase.
     * @param {User} user The User to create a JsonWebToken for
     * @param {number} tenantId ID of the active tenant for the session (claim `tid`)
     * @param {string} role The user's role within that tenant (claim `role`, defaults to "viewer")
     * @param {string} jwtSecret The key used to sign the JsonWebToken
     * @returns {string} the JsonWebToken as a string
     */
    static createJWT(user, tenantId, role, jwtSecret) {
        return jwt.sign(
            {
                username: user.username,
                h: shake256(user.password, SHAKE256_LENGTH),
                tid: tenantId,
                role: role || "viewer",
            },
            jwtSecret
        );
    }
}

module.exports = User;
