/**
 * G3 task-13 — RBAC helpers for Socket.IO handlers.
 *
 * Contract: every mutation handler follows this pattern
 *
 *     checkLogin(socket);
 *     checkPermission(socket, PERMISSIONS.MONITOR_CREATE);
 *
 * These helpers run AFTER `checkLogin(socket)` so the G2 tenant assertion
 * (`socket.userID` + `socket.tenantID`) holds first; `socket.role` is set by
 * afterLogin/switchTenant alongside `socket.tenantID` (task-13 wiring).
 *
 * All failures throw TranslatableError("forbiddenRole" | "forbiddenPermission")
 * — socket handlers already catch and forward `error.message` to the client
 * callback with `msgi18n`.
 */

const TranslatableError = require("../translatable-error");
const { buildAbilityFor } = require("./policy");
const { evaluatePermissionForAudit } = require("./audit-hook");

/**
 * Throw unless the socket's active-tenant role is one of the given roles.
 * Must be called after `checkLogin(socket)`.
 * @param {object} socket Socket.io socket (`socket.role` set by afterLogin)
 * @param {...string} roles Allowed roles (e.g. ROLES.TENANT_ADMIN)
 * @returns {void}
 * @throws {TranslatableError} forbiddenRole when the role is missing or not allowed
 */
function checkRole(socket, ...roles) {
    const role = getSocketRole(socket);
    if (!role || !roles.includes(role)) {
        throw new TranslatableError("forbiddenRole");
    }
}

/**
 * Throw unless the socket's active-tenant role holds the given permission.
 * Must be called after `checkLogin(socket)`.
 * @param {object} socket Socket.io socket (`socket.role` set by afterLogin)
 * @param {string} permission Permission string (e.g. PERMISSIONS.MONITOR_CREATE)
 * @returns {void}
 * @throws {TranslatableError} forbiddenRole on missing role, forbiddenPermission
 * when the matrix denies the permission
 */
function checkPermission(socket, permission) {
    const role = getSocketRole(socket);
    if (!role) {
        throw new TranslatableError("forbiddenRole");
    }
    if (!buildAbilityFor(role).can(permission)) {
        throw new TranslatableError("forbiddenPermission");
    }
}

/**
 * Read the socket's active-tenant role.
 * A legacy session without a role returns `null` — loud denial downstream,
 * never a silent "viewer" default.
 * @param {object} socket Socket.io socket
 * @returns {(string|null)} The role string, or null when unset
 */
function getSocketRole(socket) {
    return socket.role ?? null;
}

/**
 * RBAC check with an audit hook — mirror of `checkPermission` that routes the
 * decision through audit-hook.js so G9 can swap in an `audit_log` write
 * without any contract change.
 *
 * For G3 (task-16) this is a pass-through: it returns the SAME decision as
 * `checkPermission` (audit-hook.js is a no-op audit-wise in G3). task-14/15
 * keep using the plain `checkPermission`; this audited variant exists so a
 * G9 re-thread is a mechanical call swap, not a signature change.
 * @param {object} socket Socket.io socket (`socket.role` set by afterLogin)
 * @param {string} permission Permission string (e.g. PERMISSIONS.MONITOR_CREATE)
 * @param {string} action Audit action label (defaults to the permission)
 * @returns {void}
 * @throws {TranslatableError} forbiddenRole on missing role, forbiddenPermission
 * when the matrix denies the permission
 */
function checkPermissionWithAuditTrail(socket, permission, action = permission) {
    const role = getSocketRole(socket);
    if (!role) {
        throw new TranslatableError("forbiddenRole");
    }
    // Audit hook carries ctx for G9's audit_log row; decision still from matrix.
    const allowed = evaluatePermissionForAudit({
        role,
        userId: socket.userID,
        tenantId: socket.tenantID,
    }, permission);
    if (!allowed) {
        throw new TranslatableError("forbiddenPermission");
    }
}

module.exports = { checkRole, checkPermission, getSocketRole, checkPermissionWithAuditTrail };
