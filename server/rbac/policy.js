/**
 * RBAC Policy — role-to-permission mapping and ability builder
 * Frozen matrix per ADR-0004. Subset invariants: VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN
 */

const { ROLES } = require("./roles");
const { PERMISSIONS } = require("./permissions");

/**
 * Role-to-permission mapping (explicit allow-list)
 * Each role includes all permissions from the role below it (subset invariant).
 */
const ROLES_PERMISSIONS = Object.freeze({
    [ROLES.VIEWER]: Object.freeze([
        PERMISSIONS.MONITOR_READ,
        PERMISSIONS.STATUS_PAGE_READ,
        PERMISSIONS.NOTIFICATION_READ,
    ]),
    [ROLES.MEMBER]: Object.freeze([
        // Viewer permissions
        PERMISSIONS.MONITOR_READ,
        PERMISSIONS.STATUS_PAGE_READ,
        PERMISSIONS.NOTIFICATION_READ,
        // Member permissions
        PERMISSIONS.MONITOR_CREATE,
        PERMISSIONS.MONITOR_UPDATE,
        PERMISSIONS.MONITOR_PAUSE_RESUME,
        PERMISSIONS.NOTIFICATION_CREATE,
        PERMISSIONS.NOTIFICATION_UPDATE,
        PERMISSIONS.NOTIFICATION_DELETE,
        PERMISSIONS.TAG_MANAGE,
        PERMISSIONS.INCIDENT_MANAGE,
    ]),
    [ROLES.TENANT_ADMIN]: Object.freeze([
        // Member permissions
        PERMISSIONS.MONITOR_READ,
        PERMISSIONS.STATUS_PAGE_READ,
        PERMISSIONS.NOTIFICATION_READ,
        PERMISSIONS.MONITOR_CREATE,
        PERMISSIONS.MONITOR_UPDATE,
        PERMISSIONS.MONITOR_PAUSE_RESUME,
        PERMISSIONS.NOTIFICATION_CREATE,
        PERMISSIONS.NOTIFICATION_UPDATE,
        PERMISSIONS.NOTIFICATION_DELETE,
        PERMISSIONS.TAG_MANAGE,
        PERMISSIONS.INCIDENT_MANAGE,
        // Tenant Admin permissions
        PERMISSIONS.MONITOR_DELETE,
        PERMISSIONS.STATUS_PAGE_CREATE,
        PERMISSIONS.STATUS_PAGE_UPDATE,
        PERMISSIONS.STATUS_PAGE_DELETE,
        PERMISSIONS.MAINTENANCE_MANAGE,
        PERMISSIONS.PROXY_MANAGE,
        PERMISSIONS.DOCKER_HOST_MANAGE,
        PERMISSIONS.API_KEY_MANAGE,
        PERMISSIONS.MONITOR_GROUP_MANAGE,
        PERMISSIONS.TENANT_USER_INVITE,
        PERMISSIONS.TENANT_USER_REMOVE,
        PERMISSIONS.TENANT_USER_ROLE_UPDATE,
        PERMISSIONS.TENANT_SETTINGS_UPDATE,
    ]),
    [ROLES.SUPER_ADMIN]: Object.freeze([
        // All permissions
        ...Object.values(PERMISSIONS),
    ]),
});

/**
 * Build an ability object for a given role.
 * Returns { can(permission): boolean, canAny([...permissions]): boolean }
 * @param {string} role - The role string (e.g., "viewer", "member")
 * @returns {{ can: (perm: string) => boolean, canAny: (perms: string[]) => boolean }}
 */
function buildAbilityFor(role) {
    const permissions = ROLES_PERMISSIONS[role] || [];
    const permissionSet = new Set(permissions);

    return {
        /**
         * Check if the role has a specific permission
         * @param {string} permission - The permission string (e.g., "monitor.create")
         * @returns {boolean}
         */
        can(permission) {
            return permissionSet.has(permission);
        },
        /**
         * Check if the role has any of the specified permissions
         * @param {string[]} permissions - Array of permission strings
         * @returns {boolean}
         */
        canAny(permissions) {
            return permissions.some((p) => permissionSet.has(p));
        },
    };
}

module.exports = { ROLES_PERMISSIONS, buildAbilityFor };