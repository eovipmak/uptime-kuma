/**
 * G3 task-13 — RBAC foundation tests
 *
 * Proves the frozen contracts of server/rbac/* and the two enforcement
 * surfaces built on top of them:
 *   - roles/permissions enums (frozen, G1-compatible values)
 *   - role matrix subset invariants (VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN)
 *   - buildAbilityFor() CASL abilities (allow/deny/canAny/deny-by-default)
 *   - requireRole()/requirePermission() Express middleware
 *   - checkRole()/checkPermission() Socket.IO helpers
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { ROLES, ROLE_HIERARCHY } = require("../../server/rbac/roles");
const { PERMISSIONS } = require("../../server/rbac/permissions");
const { ROLES_PERMISSIONS, buildAbilityFor } = require("../../server/rbac/policy");
const { checkRole, checkPermission, getSocketRole } = require("../../server/rbac/socket-rbac");
const { requireRole, requirePermission, requireSuperAdmin } = require("../../server/middleware/require-rbac");
const TranslatableError = require("../../server/translatable-error");

/** All permission strings declared by the enum. */
const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * Run an Express middleware against a mock request and capture next().
 * @param {Function} middleware Middleware under test
 * @param {object|null} req Mock request (req.user may be undefined)
 * @returns {{error: (Error|null)}} The error passed to next(), or null
 */
function runMiddleware(middleware, req) {
    let error = null;
    middleware(req ?? {}, {}, (err) => {
        error = err ?? null;
    });
    return { error };
}

/**
 * Build a mock socket.io socket.
 * @param {object} props Properties to put on the socket (role, userID...)
 * @returns {object} Mock socket
 */
function makeSocket(props) {
    return { ...props };
}

describe("RBAC enums", () => {
    test("roles are frozen and match the G1 tenant_user.role values", () => {
        assert.deepStrictEqual(Object.isFrozen(ROLES), true);
        assert.deepStrictEqual(ROLES, {
            SUPER_ADMIN: "super_admin",
            TENANT_ADMIN: "tenant_admin",
            MEMBER: "member",
            VIEWER: "viewer",
        });
    });

    test("permissions are frozen with stable lowercase dotted identities", () => {
        assert.deepStrictEqual(Object.isFrozen(PERMISSIONS), true);
        const seen = new Set();
        for (const value of Object.values(PERMISSIONS)) {
            assert.match(value, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
            assert.ok(!seen.has(value), `duplicate permission string ${value}`);
            seen.add(value);
        }
        // Symbol and literal share the same words so grepping either finds
        // both declaration and call sites (e.g. TAG_MANAGE / tag.manage).
        const wordsOf = (s) => s.toLowerCase().split(/[._]/).sort().join(",");
        for (const entry of Object.entries(PERMISSIONS)) {
            assert.strictEqual(wordsOf(entry[0]), wordsOf(entry[1]));
        }
    });

    test("hierarchy lists roles from most to least privileged", () => {
        assert.deepStrictEqual(ROLE_HIERARCHY, [
            ROLES.SUPER_ADMIN,
            ROLES.TENANT_ADMIN,
            ROLES.MEMBER,
            ROLES.VIEWER,
        ]);
    });
});

describe("RBAC role matrix", () => {
    test("matrix is defined for every declared role", () => {
        for (const role of Object.values(ROLES)) {
            assert.ok(Array.isArray(ROLES_PERMISSIONS[role]));
        }
    });

    test("subset invariants hold: VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN", () => {
        const viewer = new Set(ROLES_PERMISSIONS[ROLES.VIEWER]);
        const member = new Set(ROLES_PERMISSIONS[ROLES.MEMBER]);
        const tenantAdmin = new Set(ROLES_PERMISSIONS[ROLES.TENANT_ADMIN]);
        const superAdmin = new Set(ROLES_PERMISSIONS[ROLES.SUPER_ADMIN]);

        for (const permission of viewer) {
            assert.ok(member.has(permission), `member lacks viewer permission ${permission}`);
            assert.ok(tenantAdmin.has(permission), `tenant_admin lacks viewer permission ${permission}`);
            assert.ok(superAdmin.has(permission), `super_admin lacks viewer permission ${permission}`);
        }
        for (const permission of member) {
            assert.ok(tenantAdmin.has(permission), `tenant_admin lacks member permission ${permission}`);
            assert.ok(superAdmin.has(permission), `super_admin lacks member permission ${permission}`);
        }
        for (const permission of tenantAdmin) {
            assert.ok(superAdmin.has(permission), `super_admin lacks tenant_admin permission ${permission}`);
        }
    });

    test("SUPER_ADMIN holds every declared permission", () => {
        assert.deepStrictEqual(
            new Set(ROLES_PERMISSIONS[ROLES.SUPER_ADMIN]),
            new Set(ALL_PERMISSIONS)
        );
    });

    test("system.* permissions are super-admin only", () => {
        const systemPermissions = ALL_PERMISSIONS.filter((p) => p.startsWith("system."));
        for (const permission of systemPermissions) {
            for (const role of [ ROLES.VIEWER, ROLES.MEMBER, ROLES.TENANT_ADMIN ]) {
                assert.ok(!ROLES_PERMISSIONS[role].includes(permission));
            }
        }
    });
});

describe("buildAbilityFor", () => {
    test("viewer can read but not mutate", () => {
        const ability = buildAbilityFor(ROLES.VIEWER);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_READ), true);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_CREATE), false);
        assert.strictEqual(ability.can(PERMISSIONS.TENANT_USER_INVITE), false);
    });

    test("member can create/update/pause monitors but not delete or administer tenants", () => {
        const ability = buildAbilityFor(ROLES.MEMBER);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_CREATE), true);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_UPDATE), true);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_PAUSE_RESUME), true);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_DELETE), false);
        assert.strictEqual(ability.can(PERMISSIONS.TENANT_USER_INVITE), false);
    });

    test("tenant_admin administers tenants but has no system.* permissions", () => {
        const ability = buildAbilityFor(ROLES.TENANT_ADMIN);
        assert.strictEqual(ability.can(PERMISSIONS.MONITOR_DELETE), true);
        assert.strictEqual(ability.can(PERMISSIONS.TENANT_USER_INVITE), true);
        assert.strictEqual(ability.can(PERMISSIONS.TENANT_SETTINGS_UPDATE), true);
        assert.strictEqual(ability.can(PERMISSIONS.SYSTEM_TENANT_SUSPEND), false);
        assert.strictEqual(ability.can(PERMISSIONS.SYSTEM_AUDIT_LOG_READ), false);
    });

    test("super_admin can everything including system.*", () => {
        const ability = buildAbilityFor(ROLES.SUPER_ADMIN);
        for (const permission of ALL_PERMISSIONS) {
            assert.strictEqual(ability.can(permission), true, `super_admin denied ${permission}`);
        }
    });

    test("unknown role yields deny-by-default ability", () => {
        const ability = buildAbilityFor("ghost_role");
        for (const permission of ALL_PERMISSIONS) {
            assert.strictEqual(ability.can(permission), false);
        }
    });

    test("canAny returns true when at least one permission matches", () => {
        const member = buildAbilityFor(ROLES.MEMBER);
        const viewer = buildAbilityFor(ROLES.VIEWER);
        assert.strictEqual(member.canAny([ PERMISSIONS.MONITOR_DELETE, PERMISSIONS.MONITOR_CREATE ]), true);
        assert.strictEqual(viewer.canAny([ PERMISSIONS.MONITOR_CREATE, PERMISSIONS.MONITOR_DELETE ]), false);
    });
});

describe("requireRole middleware", () => {
    test("allows a listed role", () => {
        const middleware = requireRole(ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN);
        const { error } = runMiddleware(middleware, { user: { id: 1, role: ROLES.TENANT_ADMIN } });
        assert.strictEqual(error, null);
    });

    test("denies an unlisted role with forbiddenRole", () => {
        const middleware = requireRole(ROLES.SUPER_ADMIN);
        const { error } = runMiddleware(middleware, { user: { id: 1, role: ROLES.MEMBER } });
        assert.ok(error instanceof TranslatableError);
        assert.strictEqual(error.message, "forbiddenRole");
    });

    test("denies a missing role", () => {
        const middleware = requireRole(ROLES.VIEWER);
        const { error } = runMiddleware(middleware, { user: { id: 1 } });
        assert.strictEqual(error?.message, "forbiddenRole");
    });

    test("denies an anonymous request", () => {
        const middleware = requireRole(ROLES.VIEWER);
        const { error } = runMiddleware(middleware, {});
        assert.strictEqual(error?.message, "forbiddenRole");
    });

    test("requireSuperAdmin denies non-super-admins", () => {
        const { error } = runMiddleware(requireSuperAdmin(), { user: { id: 1, role: ROLES.TENANT_ADMIN } });
        assert.strictEqual(error?.message, "forbiddenRole");
        const ok = runMiddleware(requireSuperAdmin(), { user: { id: 2, role: ROLES.SUPER_ADMIN } });
        assert.strictEqual(ok.error, null);
    });
});

describe("requirePermission middleware", () => {
    test("allows when the role's matrix grants the permission", () => {
        const middleware = requirePermission(PERMISSIONS.MONITOR_CREATE);
        const { error } = runMiddleware(middleware, { user: { id: 1, role: ROLES.MEMBER } });
        assert.strictEqual(error, null);
    });

    test("denies with forbiddenPermission when the matrix denies it", () => {
        const middleware = requirePermission(PERMISSIONS.TENANT_USER_REMOVE);
        const { error } = runMiddleware(middleware, { user: { id: 1, role: ROLES.MEMBER } });
        assert.ok(error instanceof TranslatableError);
        assert.strictEqual(error.message, "forbiddenPermission");
    });

    test("denies system.* permissions below super_admin", () => {
        const middleware = requirePermission(PERMISSIONS.SYSTEM_VIEW_ALL_TENANTS);
        const tenantAdmin = runMiddleware(middleware, { user: { id: 1, role: ROLES.TENANT_ADMIN } });
        assert.strictEqual(tenantAdmin.error?.message, "forbiddenPermission");
        const superAdmin = runMiddleware(middleware, { user: { id: 1, role: ROLES.SUPER_ADMIN } });
        assert.strictEqual(superAdmin.error, null);
    });

    test("denies a missing role with forbiddenRole", () => {
        const middleware = requirePermission(PERMISSIONS.MONITOR_READ);
        const { error } = runMiddleware(middleware, { user: { id: 1 } });
        assert.strictEqual(error?.message, "forbiddenRole");
    });
});

describe("socket RBAC helpers", () => {
    test("getSocketRole returns null for legacy sessions without a role", () => {
        assert.strictEqual(getSocketRole(makeSocket({ userID: 1 })), null);
        assert.strictEqual(getSocketRole(makeSocket({ role: ROLES.MEMBER })), ROLES.MEMBER);
    });

    test("checkRole passes for an allowed role", () => {
        const socket = makeSocket({ role: ROLES.TENANT_ADMIN });
        assert.doesNotThrow(() => checkRole(socket, ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN));
    });

    test("checkRole throws forbiddenRole otherwise", () => {
        const socket = makeSocket({ role: ROLES.MEMBER });
        assert.throws(() => checkRole(socket, ROLES.SUPER_ADMIN), (err) => {
            assert.ok(err instanceof TranslatableError);
            assert.strictEqual(err.message, "forbiddenRole");
            return true;
        });
        assert.throws(() => checkRole(makeSocket({}), ROLES.MEMBER), (err) => err.message === "forbiddenRole");
    });

    test("checkPermission passes per matrix and throws forbiddenPermission when denied", () => {
        const member = makeSocket({ role: ROLES.MEMBER });
        assert.doesNotThrow(() => checkPermission(member, PERMISSIONS.NOTIFICATION_CREATE));
        assert.throws(() => checkPermission(member, PERMISSIONS.API_KEY_MANAGE), (err) => {
            assert.ok(err instanceof TranslatableError);
            assert.strictEqual(err.message, "forbiddenPermission");
            return true;
        });
    });

    test("checkPermission throws forbiddenRole when the socket has no role", () => {
        assert.throws(() => checkPermission(makeSocket({ userID: 5 }), PERMISSIONS.MONITOR_READ), (err) => err.message === "forbiddenRole");
    });
});
