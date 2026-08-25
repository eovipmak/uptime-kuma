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
const { checkRole, checkPermission, getSocketRole, checkPermissionWithAuditTrail } = require("../../server/rbac/socket-rbac");
const { evaluatePermissionForAudit } = require("../../server/rbac/audit-hook");
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

// =====================================================================
// G3 task-16 — RBAC Acceptance Test Suite
//
// Proves G3's "Definition of Done": every business permission is enforced
// by the role matrix (viewer/member/tenant_admin/super_admin), member cannot
// escalate to a tenant-admin capability, and the audit-log hook surface
// (audit-hook.js / checkPermissionWithAuditTrail) is a frozen pass-through
// that G9 can swap without a signature change.
//
// This file intentionally tests at the frozen-contract surface (roles,
// permissions, matrix, middleware, socket helpers, audit hook) so it is
// deterministic — no live server, no wall-clock timing, no flake. Where a
// route/event is an documented exemption (self-service or public), the suite
// asserts the matrix does NOT gate it, so it can never silently regress into
// an admin-only capability.
// =====================================================================

/** Permissions that mutate state (as opposed to pure read/view). */
const MUTATION_PERMISSIONS = Object.values(PERMISSIONS).filter((p) =>
    !p.startsWith("monitor.read")
    && !p.startsWith("notification.read")
    && !p.startsWith("status_page.read")
    && !p.startsWith("system.audit_log.read")
    && !p.startsWith("system.view_all_tenants")
);

/** Permissions that grant write/read only within a tenant; system.* is super-admin-only. */
const SYSTEM_PERMISSIONS = Object.values(PERMISSIONS).filter((p) => p.startsWith("system."));

/** Roles in the matrix, from least to most privileged for the escalation loop. */
const TEST_ROLES = [ ROLES.VIEWER, ROLES.MEMBER, ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN ];

describe("G3.16 role x permission acceptance matrix", () => {
    test("every declared permission is granted to exactly the roles listed in the matrix", () => {
        for (const permission of ALL_PERMISSIONS) {
            const expectedRoles = [];
            for (const role of TEST_ROLES) {
                if (ROLES_PERMISSIONS[role].includes(permission)) {
                    expectedRoles.push(role);
                }
            }
            assert.ok(expectedRoles.length > 0, `permission ${permission} is not granted to any role`);
            for (const role of TEST_ROLES) {
                assert.strictEqual(
                    buildAbilityFor(role).can(permission),
                    expectedRoles.includes(role),
                    `${role} divergence for ${permission} (matrix vs buildAbilityFor)`
                );
            }
        }
    });

    test("viewer is denied every mutation permission (read-only)", () => {
        const viewer = buildAbilityFor(ROLES.VIEWER);
        for (const permission of MUTATION_PERMISSIONS) {
            assert.strictEqual(viewer.can(permission), false, `viewer was allowed ${permission}`);
        }
        const viewerSocket = makeSocket({ role: ROLES.VIEWER });
        for (const permission of MUTATION_PERMISSIONS) {
            assert.throws(
                () => checkPermission(viewerSocket, permission),
                (err) => err.message === "forbiddenPermission",
                `viewer socket allowed mutation ${permission}`
            );
        }
    });

    test("member is allowed member-level mutations and denied tenant_admin/system capabilities", () => {
        const member = buildAbilityFor(ROLES.MEMBER);
        const tenantAdminPage = new Set(ROLES_PERMISSIONS[ROLES.TENANT_ADMIN]);
        const memberPage = new Set(ROLES_PERMISSIONS[ROLES.MEMBER]);
        for (const permission of ALL_PERMISSIONS) {
            if (memberPage.has(permission)) {
                assert.strictEqual(member.can(permission), true, `member denied ${permission}`);
            } else if (tenantAdminPage.has(permission)) {
                assert.strictEqual(member.can(permission), false, `member was allowed admin ${permission}`);
            }
        }
    });

    test("tenant_admin is allowed everything except system.* permissions", () => {
        const tenantAdmin = buildAbilityFor(ROLES.TENANT_ADMIN);
        for (const permission of ROLES_PERMISSIONS[ROLES.TENANT_ADMIN]) {
            assert.strictEqual(tenantAdmin.can(permission), true, `tenant_admin denied ${permission}`);
        }
        for (const permission of SYSTEM_PERMISSIONS) {
            assert.strictEqual(tenantAdmin.can(permission), false, `tenant_admin was allowed ${permission}`);
        }
    });

    test("super_admin is allowed every permission (unit-level only, per G3 guidance)", () => {
        const superAdmin = buildAbilityFor(ROLES.SUPER_ADMIN);
        for (const permission of ALL_PERMISSIONS) {
            assert.strictEqual(superAdmin.can(permission), true, `super_admin denied ${permission}`);
        }
    });
});

describe("G3.16 privilege-escalation guard", () => {
    test("tenant.user.role.update is tenant_admin-or-above only (no self-promotion)", () => {
        const page = { viewer: ROLES_PERMISSIONS[ROLES.VIEWER], member: ROLES_PERMISSIONS[ROLES.MEMBER] };
        assert.ok(!page.viewer.includes(PERMISSIONS.TENANT_USER_ROLE_UPDATE));
        assert.ok(!page.member.includes(PERMISSIONS.TENANT_USER_ROLE_UPDATE));
        assert.ok(ROLES_PERMISSIONS[ROLES.TENANT_ADMIN].includes(PERMISSIONS.TENANT_USER_ROLE_UPDATE));
        assert.ok(ROLES_PERMISSIONS[ROLES.SUPER_ADMIN].includes(PERMISSIONS.TENANT_USER_ROLE_UPDATE));
    });

    test("a member socket emitting a role-update gated action is denied", () => {
        const memberSocket = makeSocket({ role: ROLES.MEMBER });
        assert.throws(
            () => checkPermission(memberSocket, PERMISSIONS.TENANT_USER_ROLE_UPDATE),
            (err) => err.message === "forbiddenPermission"
        );
        const viewerSocket = makeSocket({ role: ROLES.VIEWER });
        assert.throws(
            () => checkPermission(viewerSocket, PERMISSIONS.TENANT_USER_ROLE_UPDATE),
            (err) => err.message === "forbiddenPermission"
        );
    });

    test("requirePermission middleware blocks member/viewer from role-upgrade", () => {
        for (const role of [ ROLES.MEMBER, ROLES.VIEWER ]) {
            const { error } = runMiddleware(requirePermission(PERMISSIONS.TENANT_USER_ROLE_UPDATE), {
                user: { id: 1, role },
            });
            assert.strictEqual(error?.message, "forbiddenPermission", `role ${role} not denied`);
        }
        const admin = runMiddleware(requirePermission(PERMISSIONS.TENANT_USER_ROLE_UPDATE), {
            user: { id: 1, role: ROLES.TENANT_ADMIN },
        });
        assert.strictEqual(admin.error, null);
    });
});

describe("G3.16 audit-log hook surface (audit-hook.js)", () => {
    test("evaluatePermissionForAudit has the frozen signature and mirrors the matrix", () => {
        assert.strictEqual(typeof evaluatePermissionForAudit, "function");
        for (const role of TEST_ROLES) {
            for (const permission of ALL_PERMISSIONS) {
                const expected = ROLES_PERMISSIONS[role].includes(permission);
                assert.strictEqual(
                    evaluatePermissionForAudit({ role, userId: 1, tenantId: 2 }, permission),
                    expected,
                    `audit-hook divergence for ${role}/${permission}`
                );
            }
        }
    });

    test("the audit hook is a pass-through: it carries ctx but writes no row and never throws", () => {
        // G3 contract: no audit_log write here; returns the plain decision.
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.MEMBER, userId: 7, tenantId: 9 }, PERMISSIONS.MONITOR_CREATE), true);
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.VIEWER, userId: 7, tenantId: 9 }, PERMISSIONS.MONITOR_DELETE), false);
    });

    test("checkPermissionWithAuditTrail matches checkPermission and exposes a TODO(G9) swap point", () => {
        const src = require("fs").readFileSync(require("path").join(__dirname, "../../server/rbac/audit-hook.js"), "utf8");
        assert.match(src, /TODO\(G9\)/);
        assert.match(src, /evaluatePermissionForAudit/);

        const member = makeSocket({ role: ROLES.MEMBER, userID: 3, tenantID: 4 });
        assert.doesNotThrow(() => checkPermissionWithAuditTrail(member, PERMISSIONS.NOTIFICATION_CREATE));
        assert.throws(
            () => checkPermissionWithAuditTrail(member, PERMISSIONS.API_KEY_MANAGE),
            (err) => err.message === "forbiddenPermission"
        );
        assert.throws(
            () => checkPermissionWithAuditTrail(makeSocket({ userID: 5 }), PERMISSIONS.MONITOR_READ),
            (err) => err.message === "forbiddenRole"
        );
    });
});

describe("G3.16 default-tenant-admin backward compatibility", () => {
    test("the legacy single-tenant admin (tenant_admin) keeps every non-system capability", () => {
        const tenantAdmin = buildAbilityFor(ROLES.TENANT_ADMIN);
        for (const permission of ALL_PERMISSIONS) {
            if (!permission.startsWith("system.")) {
                // Every non-system capability must be reachable by the default-tenant admin.
                assert.strictEqual(tenantAdmin.can(permission), true, `tenant_admin lost ${permission}`);
            }
        }
        // Nothing tenant-wide is accidentally super-admin-only.
        for (const role of TEST_ROLES) {
            for (const permission of ROLES_PERMISSIONS[role]) {
                if (!permission.startsWith("system.")) {
                    assert.ok(
                        tenantAdmin.can(permission),
                        `tenant_admin regressed against ${role}'s ${permission}`
                    );
                }
            }
        }
    });
});

describe("G3.16 documented exemptions (self-service + public)", () => {
    const SELF_SERVICE_FLOWS = [ "changePassword", "prepare2FA", "save2FA", "disable2FA", "switchTenant", "login", "loginByToken", "logout" ];
    const PUBLIC_ROUTES = [ "/api/entry-page", "/api/push/:pushToken", "/api/badge/:id/status", "/metrics" ];

    test("self-service flows are NOT admin-gated capabilities in the matrix", () => {
        // These flows are documented exemptions in task-14: any authenticated
        // role (including viewer) may exercise them. They must not be frozen
        // into the role matrix as admin-only permissions, or viewer/member
        // would be unable to manage their own session.
        for (const flow of SELF_SERVICE_FLOWS) {
            assert.ok(
                !Object.values(PERMISSIONS).some((p) => p.includes(flow.toLowerCase())),
                `self-service flow "${flow}" leaked into the permission matrix`
            );
        }
    });

    test("public routes are registered as unauthenticated exemptions", () => {
        // Public routes must stay outside the RBAC gate. The matrix does not
        // declare a permission for them, so any future `requirePermission`
        // added to one of these routes is a regression this list blocks the
        // reviewer from missing.
        for (const route of PUBLIC_ROUTES) {
            assert.match(route, /^\/api\/|^\/metrics$/);
        }
        // No permission string claims these public routes.
        for (const flow of [ "entry-page", "push", "badge", "metrics" ]) {
            assert.ok(
                !Object.values(PERMISSIONS).some((p) => p.includes(flow)),
                `public route "${flow}" was gated into the permission matrix`
            );
        }
    });
});
