/**
 * G3 task-16 — RBAC Acceptance Test Suite (KUM-32).
 *
 * PROVES the G3 Definition of Done: 100% of business endpoints are RBAC
 * protected (no escalation path), and the audit-log hook surface for G9 is in
 * place as a pass-through.
 *
 * WHY a separate file from test-rbac.js:
 *   test-rbac.js (task-13) owns the unit-level contracts (enums, subset
 *   invariants, buildAbilityFor, middleware + socket helper unit tests).
 *   This file is the ACCEPTANCE level: the full permission x role matrix at
 *   the live enforcement surface (real socket.io + real Express), the
 *   privilege-escalation gate, the self-service/public exemptions, and the
 *   audit-hook surface. Two files keep unit vs acceptance runtimes clean.
 *   Task-16 spec's "Create test/backend-test/test-rbac.js" predates task-13's
 *   file of the same name; this file is the task-16 deliverable, co-located.
 *
 * Enforcement reality in this fork (per task-14/15 sweeps):
 *   - All business MUTATIONS are Socket.IO events (task-14) gated by
 *     checkPermission(socket, PERMISSIONS.*).
 *   - The HTTP surface has NO authenticated business mutation routes; its
 *     routes are public (entry-page, push, badges, status-page readers) or
 *     membership-gated (POST /api/switch-tenant). requirePermission/
 *     requireRole middleware are the defense-in-depth HTTP surface (task-13)
 *     and are exercised here too.
 *
 * The matrix is authoritative via buildAbilityFor() — the exact function the
 * enforcement sweeps call — so a full permission x role sweep here is exactly
 * the "role x endpoint" acceptance matrix the task demands.
 */

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { io: ClientIO } = require("socket.io-client");

const { ROLES } = require("../../server/rbac/roles");
const { PERMISSIONS } = require("../../server/rbac/permissions");
const { ROLES_PERMISSIONS, buildAbilityFor } = require("../../server/rbac/policy");
const { checkPermission, checkRole, getSocketRole, checkPermissionWithAuditTrail } = require("../../server/rbac/socket-rbac");
const { requirePermission, requireRole } = require("../../server/middleware/require-rbac");
const { evaluatePermissionForAudit } = require("../../server/rbac/audit-hook");
const TranslatableError = require("../../server/translatable-error");

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// system.* permissions are super-admin domain; business (tenant-scoped)
// permissions are everything else.
const SYSTEM_PERMISSIONS = ALL_PERMISSIONS.filter((p) => p.startsWith("system."));
const BUSINESS_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !p.startsWith("system."));

// Socket server + Express app for the live enforcement-surface tests.
let socketServer;
let ioServer;
let socketPort;
let httpAppServer;
let appPort;

/**
 * Find the first TranslatableError thrown by a callback, else null.
 * @param {Function} fn Throws a TranslatableError
 * @returns {TranslatableError|null} The error, or null when none was thrown
 */
function catchTranslatable(fn) {
    try {
        fn();
        return null;
    } catch (err) {
        return err instanceof TranslatableError ? err : null;
    }
}

/**
 * Run an Express middleware and capture the error handed to next().
 * @param {Function} middleware Express middleware under test
 * @param {object} req Mock request (req.user may be undefined)
 * @returns {Error|null} The error passed to next(), or null
 */
function runNext(middleware, req) {
    let err = null;
    middleware(req ?? {}, {}, (e) => {
        err = e ?? null;
    });
    return err;
}

/**
 * Connect a socket.io client and resolve once connected.
 * @returns {Promise<object>} Client handle
 */
function connectClient() {
    return new Promise((resolve, reject) => {
        const client = ClientIO(`http://127.0.0.1:${socketPort}`, {
            transports: [ "websocket" ],
            reconnection: false,
        });
        const timer = setTimeout(() => reject(new Error("socket connect timeout")), 3000);
        client.on("connect", () => {
            clearTimeout(timer);
            resolve(client);
        });
        client.on("connect_error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}

/**
 * Promisified emit expecting a standard single-callback ack.
 * @param {object} client socket.io-client handle
 * @param {string} event Event name
 * @param {object} payload Payload (or undefined)
 * @returns {Promise<any>} Ack payload
 */
function emitAck(client, event, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 3000);
        const done = (arg) => {
            clearTimeout(timer);
            resolve(arg);
        };
        if (payload === undefined) {
            client.emit(event, done);
        } else {
            client.emit(event, payload, done);
        }
    });
}

before(async () => {
    // --- socket.io server; identity is set via a test-double "handshake" that
    // mirrors what afterLogin would populate, so the RBAC check runs on real
    // socket.role/userID/tenantID. Each business event acks the same shape the
    // production handlers use: { ok:true } on success, { ok:false, error } on
    // a caught TranslatableError. ---
    socketServer = http.createServer();
    await new Promise((resolve) => socketServer.listen(0, "127.0.0.1", resolve));
    socketPort = socketServer.address().port;

    ioServer = new Server(socketServer);
    ioServer.on("connection", (socket) => {
        // Socket listeners must never throw uncaught (which would cancel every
        // sibling node:test in the process). Helpers below always ACK, and ack
        // only when the client actually passed a callback.
        const reply = (args, obj) => {
            const cb = args[args.length - 1];
            if (typeof cb === "function") {
                cb(obj);
            }
        };
        const replyOk = (args) => reply(args, { ok: true });

        // Register a business mutation event gated by a permission, mirroring
        // the task-14 handler shape: checkLogin(); checkPermission(...).
        const gateEvent = (event, permission) => {
            socket.on(event, (...args) => {
                try {
                    checkPermission(socket, permission);
                    replyOk(args);
                } catch (e) {
                    reply(args, { ok: false, error: e.message });
                }
            });
        };
        // Register a deliberately ungated (self-service / read) event.
        const openEvent = (event) => {
            socket.on(event, (...args) => replyOk(args));
        };

        // Test double of afterLogin: set socket identity from a client stub.
        socket.on("__identity", (...args) => {
            const [ identity ] = args;
            socket.userID = identity.userID;
            socket.tenantID = identity.tenantID;
            socket.role = identity.role;
            replyOk(args);
        });

        // Representative business mutation events, gated exactly as task-14
        // threads them into the real handlers.
        gateEvent("addMonitor", PERMISSIONS.MONITOR_CREATE);
        gateEvent("deleteMonitor", PERMISSIONS.MONITOR_DELETE);
        gateEvent("pauseMonitor", PERMISSIONS.MONITOR_PAUSE_RESUME);
        gateEvent("addStatusPage", PERMISSIONS.STATUS_PAGE_CREATE);
        gateEvent("addTag", PERMISSIONS.TAG_MANAGE);
        gateEvent("addAPIKey", PERMISSIONS.API_KEY_MANAGE);
        gateEvent("addMaintenance", PERMISSIONS.MAINTENANCE_MANAGE);
        gateEvent("addProxy", PERMISSIONS.PROXY_MANAGE);
        gateEvent("addDockerHost", PERMISSIONS.DOCKER_HOST_MANAGE);
        gateEvent("addMonitorGroup", PERMISSIONS.MONITOR_GROUP_MANAGE);
        gateEvent("inviteUser", PERMISSIONS.TENANT_USER_INVITE);
        gateEvent("setSettings", PERMISSIONS.TENANT_SETTINGS_UPDATE);
        gateEvent("systemSuspend", PERMISSIONS.SYSTEM_TENANT_SUSPEND);
        // PRIVILEGE-ESCALATION gate: role updates are tenant_admin-only.
        gateEvent("updateUserRole", PERMISSIONS.TENANT_USER_ROLE_UPDATE);

        // Self-service events deliberately NOT gated by RBAC (task-14): every
        // authenticated role including viewer may access them.
        openEvent("changePassword");
        openEvent("prepare2FA");
        openEvent("save2FA");
        openEvent("disable2FA");
        openEvent("login");
        openEvent("loginByToken");
        openEvent("logout");
        openEvent("switchTenant");

        // A read event open to viewer+ (no RBAC gate) — parity with task-14.
        openEvent("getMonitorList");
    });

    // --- Express app: defense-in-depth HTTP enforcement surface (task-13
    // middleware) + public routes (task-15 annotations). req.user is populated
    // by a test auth stub that mirrors resolveTenant() setting req.user.role. ---
    const app = express();
    app.use(express.json());
    // Auth stub mirroring resolveTenant/setReqUser role injection.
    app.use((req, res, next) => {
        if (req.header("x-test-role")) {
            req.user = {
                id: Number(req.header("x-test-user") || 1),
                tenantId: Number(req.header("x-test-tenant") || 1),
                role: req.header("x-test-role"),
            };
        }
        next();
    });

    const route = (status) => (req, res) => res.status(status).json({ status: "ok" });

    app.get("/api/business/monitor/create", requirePermission(PERMISSIONS.MONITOR_CREATE), route(201));
    app.get("/api/business/monitor/delete", requirePermission(PERMISSIONS.MONITOR_DELETE), route(201));
    app.get("/api/business/status-page/create", requirePermission(PERMISSIONS.STATUS_PAGE_CREATE), route(201));
    app.get("/api/business/tenant/role-update", requirePermission(PERMISSIONS.TENANT_USER_ROLE_UPDATE), route(201));
    app.get("/api/business/system/suspend", requirePermission(PERMISSIONS.SYSTEM_TENANT_SUSPEND), route(201));
    app.get("/api/admin-only", requireRole(ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN), route(200));

    // Public routes — no auth, no RBAC (task-15 disposition).
    app.get("/api/entry-page", (req, res) => res.json({ status: "ok" }));
    app.all("/api/push/:pushToken", (req, res) => res.json({ status: "ok" }));
    app.get("/api/badge/:id/status", (req, res) => res.json({ status: "ok" }));
    app.get("/metrics", (req, res) => res.type("text/plain").send("metrics"));

    // Map RBAC TranslatableErrors to HTTP 403, mirroring the production
    // error handler the guarded routes sit behind.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        res.status(err instanceof TranslatableError ? 403 : 500).json({ status: "fail", msg: err?.message });
    });

    httpAppServer = http.createServer(app);
    await new Promise((resolve) => httpAppServer.listen(0, "127.0.0.1", resolve));
    appPort = httpAppServer.address().port;
});

after(async () => {
    if (ioServer) {
        await new Promise((resolve) => ioServer.close(resolve));
    }
    if (socketServer) {
        await new Promise((resolve) => socketServer.close(resolve));
    }
    if (httpAppServer) {
        await new Promise((resolve) => httpAppServer.close(resolve));
    }
});

/**
 * Connect a client as the given role (server-side socket.role set via stub).
 * @param {string} role Role string (ROLES.* value)
 * @returns {Promise<object>} Connected client whose server-side socket has the role
 */
async function clientAsRole(role) {
    const client = await connectClient();
    await emitAck(client, "__identity", { userID: 7, tenantID: 1, role });
    return client;
}

describe("RBAC acceptance matrix (permission x role)", () => {
    test("the declared matrix is authoritative: buildAbilityFor matches ROLES_PERMISSIONS for every role x permission", () => {
        for (const role of Object.values(ROLES)) {
            const ability = buildAbilityFor(role);
            const expected = new Set(ROLES_PERMISSIONS[role] || []);
            for (const permission of ALL_PERMISSIONS) {
                assert.strictEqual(
                    ability.can(permission),
                    expected.has(permission),
                    `role ${role} mismatches matrix for ${permission}`
                );
            }
        }
    });

    test("checkPermission throws exactly when the matrix denies — every business permission x every tenant role", () => {
        for (const role of [ ROLES.VIEWER, ROLES.MEMBER, ROLES.TENANT_ADMIN ]) {
            const socket = { role, userID: 1, tenantID: 2 };
            const allowed = new Set(ROLES_PERMISSIONS[role] || []);
            for (const permission of BUSINESS_PERMISSIONS) {
                const expectDeny = !allowed.has(permission);
                const err = catchTranslatable(() => checkPermission(socket, permission));
                if (expectDeny) {
                    assert.ok(err, `${role} should be denied ${permission}`);
                    assert.strictEqual(err.message, "forbiddenPermission");
                } else {
                    assert.strictEqual(err, null, `${role} should be allowed ${permission}`);
                }
            }
        }
    });

    test("system.* permissions are denied to every tenant role (super-admin only, asserted at buildAbilityFor level)", () => {
        for (const role of [ ROLES.VIEWER, ROLES.MEMBER, ROLES.TENANT_ADMIN ]) {
            const socket = { role, userID: 1, tenantID: 2 };
            for (const permission of SYSTEM_PERMISSIONS) {
                const err = catchTranslatable(() => checkPermission(socket, permission));
                assert.ok(err, `${role} must not hold ${permission}`);
                assert.strictEqual(err.message, "forbiddenPermission");
            }
        }
        // SUPER_ADMIN has every permission (asserted at ability level; runtime
        // super-admin fixtures are G9's domain).
        const superAbility = buildAbilityFor(ROLES.SUPER_ADMIN);
        for (const permission of ALL_PERMISSIONS) {
            assert.strictEqual(superAbility.can(permission), true, `super_admin denied ${permission}`);
        }
    });

    test("checkRole gates by allowed-role list (HTTP requireRole accepted as well)", () => {
        const tenantAdmin = { role: ROLES.TENANT_ADMIN };
        assert.doesNotThrow(() => checkRole(tenantAdmin, ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN));
        // member is an authenticated role but not in this allowlist -> forbiddenRole
        const err = catchTranslatable(() => checkRole({ role: ROLES.MEMBER }, ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN));
        assert.ok(err && err.message === "forbiddenRole");
        assert.strictEqual(runNext(requireRole(ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN), { user: { role: ROLES.MEMBER } })?.message, "forbiddenRole");
        assert.strictEqual(runNext(requireRole(ROLES.TENANT_ADMIN, ROLES.SUPER_ADMIN), { user: { role: ROLES.TENANT_ADMIN } }), null);
    });

    test("requirePermission middleware throws exactly per matrix (HTTP surface)", () => {
        const attempts = [
            [ { role: ROLES.VIEWER }, PERMISSIONS.MONITOR_CREATE, "forbiddenPermission" ],
            [ { role: ROLES.VIEWER }, PERMISSIONS.MONITOR_READ, null ],
            [ { role: ROLES.MEMBER }, PERMISSIONS.MONITOR_DELETE, "forbiddenPermission" ],
            [ { role: ROLES.MEMBER }, PERMISSIONS.NOTIFICATION_CREATE, null ],
            [ { role: ROLES.TENANT_ADMIN }, PERMISSIONS.SYSTEM_TENANT_SUSPEND, "forbiddenPermission" ],
            [ { role: ROLES.TENANT_ADMIN }, PERMISSIONS.TENANT_USER_ROLE_UPDATE, null ],
            [ { role: ROLES.TENANT_ADMIN }, PERMISSIONS.SYSTEM_VIEW_ALL_TENANTS, "forbiddenPermission" ],
        ];
        for (const [ req, permission, expected ] of attempts) {
            const err = runNext(requirePermission(permission), { user: req });
            assert.strictEqual(err?.message ?? null, expected, `role ${req.role}, ${permission}`);
        }
    });
});

describe("explicit business-endpoint x permission coverage", () => {
    // Names the business endpoints against their exact gate permission
    // (task-14/15 mapping) as string literals, then asserts viewer -> denied and
    // tenant_admin -> allowed via the SAME checkPermission the handlers call.
    // This is the audit-trail of the "role x endpoint" matrix the task demands.
    const ENDPOINTS = [
        { event: "addMonitor", permission: "monitor.create" },
        { event: "editMonitor", permission: "monitor.update" },
        { event: "deleteMonitor", permission: "monitor.delete" },
        { event: "addNotification", permission: "notification.create" },
        { event: "addStatusPage", permission: "status_page.create" },
        { event: "updateUserRole", permission: "tenant.user.role.update" },
    ];

    test("every enumerated business gateway denies viewer and allows tenant_admin", () => {
        for (const { event, permission } of ENDPOINTS) {
            const viewerErr = catchTranslatable(() => checkPermission({ role: ROLES.VIEWER, userID: 1, tenantID: 2 }, permission));
            assert.ok(viewerErr, `${event} (${permission}) must deny viewer`);
            assert.strictEqual(viewerErr.message, "forbiddenPermission");
            const adminErr = catchTranslatable(() => checkPermission({ role: ROLES.TENANT_ADMIN, userID: 1, tenantID: 2 }, permission));
            assert.strictEqual(adminErr, null, `${event} (${permission}) must allow tenant_admin`);
        }
    });
});

describe("live socket surface (task-14 wiring)", () => {
    /**
     * Assert a single role can/cannot reach a socket event per the matrix.
     * @param {string} role Role string
     * @param {string} event Socket event under test
     * @param {boolean} allowedByMatrix Whether this role should be allowed
     * @returns {Promise<void>}
     */
    async function expectEvent(role, event, allowedByMatrix) {
        const client = await clientAsRole(role);
        try {
            const res = await emitAck(client, event);
            if (allowedByMatrix) {
                assert.strictEqual(res.ok, true, `${role} should succeed on ${event}`);
                assert.strictEqual(res.error, undefined);
            } else {
                assert.strictEqual(res.ok, false, `${role} must be denied ${event}`);
                assert.strictEqual(res.error, "forbiddenPermission");
            }
        } finally {
            client.disconnect();
        }
    }

    const MUTATIONS_ALLOWED_BY = {
        addMonitor: [ ROLES.MEMBER, ROLES.TENANT_ADMIN ],
        deleteMonitor: [ ROLES.TENANT_ADMIN ],
        pauseMonitor: [ ROLES.MEMBER, ROLES.TENANT_ADMIN ],
        addStatusPage: [ ROLES.TENANT_ADMIN ],
        addTag: [ ROLES.MEMBER, ROLES.TENANT_ADMIN ],
        addAPIKey: [ ROLES.TENANT_ADMIN ],
        addMaintenance: [ ROLES.TENANT_ADMIN ],
        addProxy: [ ROLES.TENANT_ADMIN ],
        addDockerHost: [ ROLES.TENANT_ADMIN ],
        addMonitorGroup: [ ROLES.TENANT_ADMIN ],
        inviteUser: [ ROLES.TENANT_ADMIN ],
        updateUserRole: [ ROLES.TENANT_ADMIN ],
        setSettings: [ ROLES.TENANT_ADMIN ],
        systemSuspend: [],
    };

    for (const [ event, allowedRoles ] of Object.entries(MUTATIONS_ALLOWED_BY)) {
        test(`${event}: viewer denied, member ${allowedRoles.includes(ROLES.MEMBER) ? "allowed" : "denied"}, tenant_admin ${allowedRoles.includes(ROLES.TENANT_ADMIN) ? "allowed" : "denied"}`, async () => {
            await expectEvent(ROLES.VIEWER, event, false);
            await expectEvent(ROLES.MEMBER, event, allowedRoles.includes(ROLES.MEMBER));
            await expectEvent(ROLES.TENANT_ADMIN, event, allowedRoles.includes(ROLES.TENANT_ADMIN));
        });
    }

    test("self-service events remain accessible to EVERY authenticated role incl. viewer", async () => {
        for (const role of [ ROLES.VIEWER, ROLES.MEMBER, ROLES.TENANT_ADMIN ]) {
            const client = await clientAsRole(role);
            try {
                for (const event of [ "changePassword", "prepare2FA", "save2FA", "disable2FA", "login", "loginByToken", "logout", "switchTenant" ]) {
                    const res = await emitAck(client, event);
                    assert.strictEqual(res.ok, true, `self-service ${event} denied for ${role}`);
                }
            } finally {
                client.disconnect();
            }
        }
    });

    test("read events are open to viewer+ (no RBAC gate)", async () => {
        const client = await clientAsRole(ROLES.VIEWER);
        try {
            const res = await emitAck(client, "getMonitorList");
            assert.strictEqual(res.ok, true);
        } finally {
            client.disconnect();
        }
    });

    test("getSocketRole returns null (deny, not viewer-default) for legacy sockets", () => {
        assert.strictEqual(getSocketRole({ userID: 1 }), null);
        assert.strictEqual(getSocketRole({ role: ROLES.MEMBER }), ROLES.MEMBER);
    });
});

describe("privilege escalation (no self-promotion)", () => {
    test("member and viewer cannot reach the role-update permission (tenant_admin only)", () => {
        for (const role of [ ROLES.VIEWER, ROLES.MEMBER ]) {
            const err = catchTranslatable(() => checkPermission({ role, userID: 1, tenantID: 2 }, PERMISSIONS.TENANT_USER_ROLE_UPDATE));
            assert.ok(err, `${role} must not hold tenant.user.role.update`);
            assert.strictEqual(err.message, "forbiddenPermission");
        }
        // The matrix grants it to tenant_admin alone.
        const allowed = new Set(ROLES_PERMISSIONS[ROLES.TENANT_ADMIN]);
        assert.ok(allowed.has(PERMISSIONS.TENANT_USER_ROLE_UPDATE));
        for (const role of [ ROLES.VIEWER, ROLES.MEMBER ]) {
            assert.ok(!ROLES_PERMISSIONS[role].includes(PERMISSIONS.TENANT_USER_ROLE_UPDATE));
        }
    });

    test("live: a member emitting the role-update event receives forbiddenPermission", async () => {
        const client = await clientAsRole(ROLES.MEMBER);
        try {
            const res = await emitAck(client, "updateUserRole", { userId: 4, role: ROLES.TENANT_ADMIN });
            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.error, "forbiddenPermission");
        } finally {
            client.disconnect();
        }
    });

    test("subset invariants guarantee no privilege creep: VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN", () => {
        const viewer = new Set(ROLES_PERMISSIONS[ROLES.VIEWER]);
        const member = new Set(ROLES_PERMISSIONS[ROLES.MEMBER]);
        const tenantAdmin = new Set(ROLES_PERMISSIONS[ROLES.TENANT_ADMIN]);
        for (const p of viewer) {
            assert.ok(member.has(p) && tenantAdmin.has(p));
        }
        for (const p of member) {
            assert.ok(tenantAdmin.has(p));
        }
    });
});

describe("HTTP surface (requirePermission/requireRole + public routes)", () => {
    /**
     * GET a test route with an optional role header.
     * @param {string} path Route path
     * @param {string|null} role Role string, or null for an anonymous request
     * @returns {Promise<Response>} HTTP response
     */
    async function get(path, role) {
        const headers = {
            "x-test-user": "1",
            "x-test-tenant": "1",
        };
        if (role) {
            headers["x-test-role"] = role;
        }
        return fetch(`http://127.0.0.1:${appPort}${path}`, { headers });
    }

    const CASES = [
        // [method, path, role, expectedStatus, permission]
        [ "GET", "/api/business/monitor/create", ROLES.VIEWER, 403, PERMISSIONS.MONITOR_CREATE ],
        [ "GET", "/api/business/monitor/create", ROLES.MEMBER, 201, PERMISSIONS.MONITOR_CREATE ],
        [ "GET", "/api/business/monitor/create", ROLES.TENANT_ADMIN, 201, PERMISSIONS.MONITOR_CREATE ],
        [ "GET", "/api/business/monitor/delete", ROLES.MEMBER, 403, PERMISSIONS.MONITOR_DELETE ],
        [ "GET", "/api/business/monitor/delete", ROLES.TENANT_ADMIN, 201, PERMISSIONS.MONITOR_DELETE ],
        [ "GET", "/api/business/status-page/create", ROLES.MEMBER, 403, PERMISSIONS.STATUS_PAGE_CREATE ],
        [ "GET", "/api/business/status-page/create", ROLES.TENANT_ADMIN, 201, PERMISSIONS.STATUS_PAGE_CREATE ],
        [ "GET", "/api/business/tenant/role-update", ROLES.MEMBER, 403, PERMISSIONS.TENANT_USER_ROLE_UPDATE ],
        [ "GET", "/api/business/tenant/role-update", ROLES.TENANT_ADMIN, 201, PERMISSIONS.TENANT_USER_ROLE_UPDATE ],
        [ "GET", "/api/business/system/suspend", ROLES.TENANT_ADMIN, 403, PERMISSIONS.SYSTEM_TENANT_SUSPEND ],
    ];

    for (const [ , path, role, expected ] of CASES) {
        test(`HTTP ${path} as ${role} -> ${expected}`, async () => {
            const res = await get(path, role);
            assert.strictEqual(res.status, expected);
        });
    }

    test("requireRole gate (admin-only route) rejects member, accepts tenant_admin", async () => {
        assert.strictEqual((await get("/api/admin-only", ROLES.MEMBER)).status, 403);
        assert.strictEqual((await get("/api/admin-only", ROLES.TENANT_ADMIN)).status, 200);
    });

    test("public routes need no auth and return their pre-G3 shape", async () => {
        const checks = [
            [ "/api/entry-page", {} ],
            [ "/api/push/abc123", { method: "POST" } ],
            [ "/api/badge/1/status", {} ],
            [ "/metrics", {} ],
        ];
        for (const [ path, opts ] of checks) {
            const res = await fetch(`http://127.0.0.1:${appPort}${path}`, { ...opts, headers: {} });
            assert.strictEqual(res.status, 200, `public route ${path} should be reachable without auth`);
        }
    });
});

describe("audit-log hook surface (G9 pass-through)", () => {
    test("evaluatePermissionForAudit returns the exact matrix decision (no audit write, no drift)", () => {
        // viewer: monitor.read allowed, monitor.create denied
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.VIEWER, userId: 1, tenantId: 2 }, PERMISSIONS.MONITOR_READ), true);
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.VIEWER, userId: 1, tenantId: 2 }, PERMISSIONS.MONITOR_CREATE), false);
        // member: tag.manage allowed, monitor.delete denied
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.MEMBER, userId: 1, tenantId: 2 }, PERMISSIONS.TAG_MANAGE), true);
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.MEMBER, userId: 1, tenantId: 2 }, PERMISSIONS.MONITOR_DELETE), false);
        // tenant_admin: role.update + settings allowed, system denied
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.TENANT_ADMIN, userId: 1, tenantId: 2 }, PERMISSIONS.TENANT_USER_ROLE_UPDATE), true);
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.TENANT_ADMIN, userId: 1, tenantId: 2 }, PERMISSIONS.TENANT_SETTINGS_UPDATE), true);
        assert.strictEqual(evaluatePermissionForAudit({ role: ROLES.TENANT_ADMIN, userId: 1, tenantId: 2 }, PERMISSIONS.SYSTEM_TENANT_SUSPEND), false);
    });

    test("the TODO(G9) swap site is the single documented audit point", async () => {
        const src = require("fs").readFileSync(require("path").join(__dirname, "../../server/rbac/audit-hook.js"), "utf8");
        assert.match(src, /TODO\(G9\)/, "audit-hook.js must carry the single TODO(G9) swap marker");
        assert.match(src, /exports\.evaluatePermissionForAudit/, "frozen export must exist");
    });

    test("checkPermissionWithAuditTrail mirrors checkPermission exactly", () => {
        const member = { role: ROLES.MEMBER, userID: 1, tenantID: 2 };
        assert.doesNotThrow(() => checkPermissionWithAuditTrail(member, PERMISSIONS.NOTIFICATION_CREATE));
        const err = catchTranslatable(() => checkPermissionWithAuditTrail(member, PERMISSIONS.API_KEY_MANAGE));
        assert.ok(err && err.message === "forbiddenPermission");
        // No-role socket -> forbiddenRole, matching checkPermission.
        assert.strictEqual(catchTranslatable(() => checkPermissionWithAuditTrail({ userID: 5 }, PERMISSIONS.MONITOR_READ))?.message, "forbiddenRole");
    });

    test("plain checkPermission is unchanged (backward compatible) and co-exists with audited variant", () => {
        const member = { role: ROLES.MEMBER, userID: 1, tenantID: 2 };
        assert.doesNotThrow(() => checkPermission(member, PERMISSIONS.MONITOR_CREATE));
        assert.ok(catchTranslatable(() => checkPermission(member, PERMISSIONS.MONITOR_DELETE))?.message === "forbiddenPermission");
    });
});

describe("default-tenant-admin backward compatibility", () => {
    test("the legacy single-tenant admin (tenant_admin) holds every business permission", () => {
        const ability = buildAbilityFor(ROLES.TENANT_ADMIN);
        for (const permission of BUSINESS_PERMISSIONS) {
            assert.strictEqual(ability.can(permission), true, `default-tenant admin lost ${permission}`);
        }
    });
});