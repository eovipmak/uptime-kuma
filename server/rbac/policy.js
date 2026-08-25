/**
 * G3 task-13 — RBAC policy: role-to-permission mapping and ability builder.
 *
 * Frozen matrix. Subset invariants hold explicitly:
 * VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN — every role's list contains
 * the full set of the role below it, so no implicit inheritance is needed.
 *
 * Contract (frozen for G7): buildAbilityFor(role) returns a CASL Ability
 * exposing `{ can(permission), canAny([...]) }`. Each allowed permission is
 * encoded as a `{ action: permission, subject: "all" }` rule; CASL's
 * single-argument `can(action)` matches it directly. Resource-level
 * owner-checks are G4's responsibility — never add subject-specific rules
 * here.
 *
 * Unknown/stale role values yield a deny-by-default empty ability (with a
 * warning log) rather than a throw, so legacy rows cannot crash a request.
 */

const { Ability, AbilityBuilder } = require("@casl/ability");
const { log } = require("../../src/util");
const { ROLES } = require("./roles");
const { PERMISSIONS } = require("./permissions");

/**
 * Role-to-permission mapping (explicit allow-list).
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
        // Super Admin receives every declared permission, including system.*
        ...Object.values(PERMISSIONS),
    ]),
});

/**
 * CASL ability extended with the frozen `canAny` helper. Everything else
 * (rules access, `cannot`, etc.) is stock CASL, so G7 can bundle this module
 * isomorphically.
 */
class RoleAbility extends Ability {
    /**
     * Check whether the role holds any of the given permissions.
     * @param {string[]} permissions Permission strings (e.g. ["monitor.read"])
     * @returns {boolean} True when at least one permission is granted
     */
    canAny(permissions) {
        return permissions.some((permission) => this.can(permission));
    }
}

/**
 * Build a CASL ability for a given role.
 * @param {string} role - The role string (e.g. ROLES.VIEWER)
 * @returns {RoleAbility} Ability with `{ can(permission): boolean, canAny([...]): boolean }`
 */
function buildAbilityFor(role) {
    const allowed = ROLES_PERMISSIONS[role];

    if (!allowed) {
        log.warn("rbac", `buildAbilityFor: unknown role "${role}", denying all permissions`);
    }

    const { can, rules } = new AbilityBuilder(RoleAbility);
    for (const permission of (allowed || [])) {
        can(permission, "all");
    }
    return new RoleAbility(rules);
}

module.exports = { ROLES_PERMISSIONS, buildAbilityFor };
