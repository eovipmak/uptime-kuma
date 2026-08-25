/**
 * G2.12 — Force-logout on tenant removal + G2 auth-flow integration suite
 *
 * The G2 Definition-of-Done evidence (kanban task-12): end-to-end tests for
 * the login → switch → logout → invalid-tenant flows plus the plan's explicit
 * edge case "user bị xóa khỏi tenant khi đang online → force logout".
 *
 * Harness choices (documented per task-12 step 4 — no in-process server-boot
 * precedent existed when this suite was written):
 *
 * 1. Database: a fresh temp SQLite file wired into redbean-node via R.setup()
 *    with the minimal schema (pattern of test-resolve-tenant-middleware.js).
 *    All flows run against this REAL database layer, so membership checks,
 *    revocation and JWT `h` claims exercise real data.
 *
 * 2. Socket handlers: the production handlers are inline closures inside
 *    server/server.js main(), which must not be required from tests (its own
 *    header warns of circular dependencies). This harness therefore binds
 *    handler-shaped wrappers that call exactly the same imported building
 *    blocks as production — auth.login/listTenantsForUser (server/auth.js),
 *    User.createJWT, checkLogin (server/util-server.js), joinUserRooms/
 *    leaveUserRooms (G2.11 room helpers), jwt.verify + shake256 for
 *    loginByToken — over a REAL socket.io server with REAL socket.io-client
 *    connections on an ephemeral port.
 *
 * 3. HTTP /api/switch-tenant: requiring server/routers/api-router.js pulls
 *    the ESM-only `unlimited-timeout` chain, which fails on Node < 22 (the
 *    repo's supported range includes Node 18). The route is mirrored with
 *    the same REAL pieces it composes — bearerAuth() (with its documented
 *    test-injectable secretProvider), findTenantByIdOrSlug(),
 *    getMembershipRole(), User.createJWT — so the middleware behaviour,
 *    401 path and membership denial are all exercised for real.
 *
 * 4. Force-logout job: the REAL server/jobs/check-tenant-membership.js
 *    module driven deterministically through its exported runOnce() hook
 *    (no wall-clock timing). UptimeKumaServer itself is not constructible on
 *    Node 18 (same ESM chain), so the job receives a server double whose
 *    disconnectAllSocketClientsForTenant mirrors the class method's
 *    algorithm using the real userRoom() key helper; the assertion is that
 *    the job calls it for exactly the revoked identities and that connected
 *    clients really receive "forceLogoutTenant" and drop.
 */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const express = require("express");
const { Server } = require("socket.io");
const { io: ClientIO } = require("socket.io-client");

process.env.NODE_ENV = "development";

const { R } = require("redbean-node");
const auth = require("../../server/auth");
const User = require("../../server/model/user");
const passwordHash = require("../../server/password-hash");
const { checkLogin, shake256, SHAKE256_LENGTH } = require("../../server/util-server");
const { joinUserRooms, leaveUserRooms, userRoom } = require("../../server/socket-handlers/tenant-room");
const { bearerAuth, findTenantByIdOrSlug, getMembershipRole } = require("../../server/middleware");
const job = require("../../server/jobs/check-tenant-membership");

/** Deterministic test JWT secret (production secret comes from settings). */
const JWT_SECRET = "g2-task-12-integration-test-secret";

// Fixture ids (explicit so room keys and claims are predictable)
const TENANT_DEFAULT = 1;
const TENANT_ACME = 2;
const TENANT_GHOST = 3;

let db;
let dbPath;
let ioServer;
let socketServer;
let socketPort;
let httpAppServer;
let appPort;

/** Fixture user ids (resolved after seeding). */
let aliceId;
let bobId;

/**
 * Create a fresh knex instance backed by a temp SQLite file, wired into
 * redbean-node the same way production does.
 * @param {string} testDbPath Path of the temp SQLite database file
 * @returns {Promise<object>} knex instance (already R.setup()-wired)
 */
async function createTestKnex(testDbPath) {
    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");

    const knex = require("knex");
    const instance = knex({
        client: Dialect,
        connection: {
            filename: testDbPath,
        },
        useNullAsDefault: true,
    });

    R.setup(instance);

    return instance;
}

/**
 * Remove a temp database file (+ SQLite sidecar files) if present.
 * @param {string} testDbPath Path of the temp SQLite database file
 * @returns {void}
 */
function removeTestDbFile(testDbPath) {
    for (const suffix of [ "", "-wal", "-shm" ]) {
        if (fs.existsSync(testDbPath + suffix)) {
            fs.rmSync(testDbPath + suffix);
        }
    }
}

/**
 * Resolve once the client socket disconnects (or fail after a deadline).
 * @param {object} client socket.io-client handle
 * @returns {Promise<string>} Disconnect reason
 */
function waitForDisconnect(client) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket never disconnected")), 3000);
        client.once("disconnect", (reason) => {
            clearTimeout(timer);
            resolve(reason);
        });
    });
}

/**
 * Promisified emit expecting the standard single-callback ack shape. A
 * missing payload is omitted entirely so the ack function stays the LAST
 * argument (socket.io strips it from the wire and hands it to the handler
 * as its final parameter — mirroring how the production frontend emits).
 * @param {object} client socket.io-client handle
 * @param {string} event Event name
 * @param {any} payload Payload (omit for no-arg events like logout)
 * @returns {Promise<any>} Ack payload
 */
function emitAck(client, event, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 3000);
        const done = (...args) => {
            clearTimeout(timer);
            resolve(args[0]);
        };
        if (payload === undefined) {
            client.emit(event, done);
        } else {
            client.emit(event, payload, done);
        }
    });
}

/**
 * Connect one real client and wait for the transport to be live.
 * Reconnection is disabled: server-driven disconnects (force logout) must
 * stay final, otherwise retry timers keep the test process alive forever.
 * @returns {Promise<object>} Connected socket.io-client handle
 */
function connectClient() {
    return new Promise((resolve, reject) => {
        const client = ClientIO(`http://127.0.0.1:${socketPort}`, {
            transports: [ "websocket" ],
            reconnection: false,
        });
        const timer = setTimeout(() => reject(new Error("connect timeout")), 3000);
        client.on("connect", () => {
            clearTimeout(timer);
            resolve(client);
        });
        client.on("connect_error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Server-side socket handle for a connected client (for room/state probes).
 * @param {object} client socket.io-client handle
 * @returns {object} Server-side Socket object
 */
function serverSide(client) {
    return ioServer.of("/").sockets.get(client.id);
}

/**
 * Decode a JWT without verification (claims assertions only).
 * @param {string} token JWT
 * @returns {object} Decoded claims
 */
function decode(token) {
    return jwt.decode(token);
}

before(async () => {
    // --- database ---
    dbPath = path.join(os.tmpdir(), `kum-g2-auth-test-${process.pid}-${Date.now()}.sqlite3`);
    removeTestDbFile(dbPath);
    db = await createTestKnex(dbPath);

    await db.schema.createTable("user", (table) => {
        table.increments("id").primary();
        table.string("username");
        table.string("password");
        table.integer("active");
    });
    await db.schema.createTable("tenant", (table) => {
        table.increments("id").primary();
        table.string("name");
        table.string("slug").unique();
        table.string("plan");
        table.string("status");
        table.string("custom_domain");
    });
    await db.schema.createTable("tenant_user", (table) => {
        table.increments("id").primary();
        table.integer("user_id");
        table.integer("tenant_id");
        table.string("role");
    });

    await db("tenant").insert([
        { id: TENANT_DEFAULT, name: "Default", slug: "default", plan: "free", status: "active" },
        { id: TENANT_ACME, name: "Acme", slug: "acme", plan: "pro", status: "active" },
        { id: TENANT_GHOST, name: "Ghost", slug: "ghost", plan: "free", status: "active" },
    ]);

    await db("user").insert({
        username: "alice",
        password: await passwordHash.generate("correct-horse"),
        active: 1,
    });
    await db("user").insert({
        username: "bob",
        password: await passwordHash.generate("battery-staple"),
        active: 1,
    });

    const users = await db("user").select();
    aliceId = users.find((u) => u.username === "alice").id;
    bobId = users.find((u) => u.username === "bob").id;

    await db("tenant_user").insert([
        { user_id: aliceId, tenant_id: TENANT_DEFAULT, role: "admin" },
        { user_id: aliceId, tenant_id: TENANT_ACME, role: "viewer" },
        { user_id: bobId, tenant_id: TENANT_DEFAULT, role: "viewer" },
    ]);

    // --- socket.io server with production-shaped auth handlers ---
    socketServer = http.createServer();
    await new Promise((resolve) => socketServer.listen(0, "127.0.0.1", resolve));
    socketPort = socketServer.address().port;

    ioServer = new Server(socketServer);

    ioServer.on("connection", (socket) => {

        // Mirrors server/server.js "login" (task-09 contract)
        socket.on("login", async (data, callback) => {
            try {
                if (typeof callback !== "function") {
                    return;
                }
                const user = await auth.login(data?.username, data?.password);
                if (!user) {
                    callback({ ok: false, msg: "authIncorrectCreds", msgi18n: true });
                    return;
                }
                const tenants = await auth.listTenantsForUser(user.id);
                if (tenants.length === 0) {
                    callback({ ok: false, msg: "authNoTenants", msgi18n: true });
                    return;
                }
                socket.userID = user.id;
                socket.tenantID = tenants[0].id;
                joinUserRooms(socket, { tenantId: tenants[0].id, userId: user.id });
                callback({
                    ok: true,
                    token: User.createJWT(user, tenants[0].id, tenants[0].role, JWT_SECRET),
                    tenants,
                    activeTenantId: tenants[0].id,
                });
            } catch (e) {
                callback({ ok: false, msg: e.message });
            }
        });

        // Mirrors server/server.js "loginByToken" (task-09 contract incl. the
        // fallback-to-first-accessible-tenant rule for stale/invalid tid)
        socket.on("loginByToken", async (token, callback) => {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                const user = await R.findOne("user", " username = ? AND active = 1 ", [ decoded.username ]);
                if (!user) {
                    throw new Error("authInvalidToken");
                }
                if (decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                    throw new Error("The token is invalid due to password change or old token");
                }
                const tenants = await auth.listTenantsForUser(user.id);
                if (tenants.length === 0) {
                    callback({ ok: false, msg: "authNoTenants", msgi18n: true });
                    return;
                }
                let membership = tenants.find((tenant) => tenant.id === decoded.tid);
                let issuedToken = token;
                if (!membership) {
                    membership = tenants[0];
                }
                if (membership.id !== decoded.tid) {
                    issuedToken = User.createJWT(user, membership.id, membership.role, JWT_SECRET);
                }
                socket.userID = user.id;
                socket.tenantID = membership.id;
                joinUserRooms(socket, { tenantId: membership.id, userId: user.id });
                callback({ ok: true, token: issuedToken, tenants, activeTenantId: membership.id });
            } catch (error) {
                callback({ ok: false, msg: "authInvalidToken", msgi18n: true });
            }
        });

        // Mirrors server/server.js "switchTenant" (task-11 contract)
        socket.on("switchTenant", async (targetTenant, callback) => {
            try {
                if (typeof callback !== "function") {
                    return;
                }
                checkLogin(socket);

                const target = await findTenantByIdOrSlug(targetTenant);
                const membershipRole = target == null
                    ? null
                    : await getMembershipRole(socket.userID, target.id);

                if (membershipRole == null) {
                    callback({ ok: false, msg: "You do not have access to this tenant." });
                    return;
                }

                const user = await R.findOne("user", " id = ? AND active = 1 ", [ socket.userID ]);
                if (!user) {
                    throw new Error("User inactive or deleted.");
                }

                const token = User.createJWT(user, target.id, membershipRole, JWT_SECRET);
                leaveUserRooms(socket);
                socket.tenantID = target.id;
                joinUserRooms(socket, { tenantId: target.id, userId: socket.userID });

                callback({
                    ok: true,
                    token,
                    tenants: await auth.listTenantsForUser(user.id),
                    activeTenantId: target.id,
                });
            } catch (error) {
                if (typeof callback === "function") {
                    callback({ ok: false, msg: error.message });
                }
            }
        });

        // Mirrors server/server.js "logout" (task-11 contract)
        socket.on("logout", async (callback) => {
            leaveUserRooms(socket);
            socket.tenantID = null;
            socket.userID = null;
            if (typeof callback === "function") {
                callback();
            }
        });
    });

    /**
     * Server double handed to the job's runOnce(). disconnectAllSocketClientsForTenant
     * mirrors UptimeKumaServer.disconnectAllSocketClientsForTenant (same room-key
     * helper, same strict identity match); see header note 4.
     */
    global.__jobServerDouble = {
        io: ioServer,
        disconnected: [],
        disconnectAllSocketClientsForTenant(tenantId, userID) {
            const key = userRoom(tenantId, userID);
            for (const s of ioServer.of("/").sockets.values()) {
                if (
                    s.tenantID === Number(tenantId)
                    && s.userID === Number(userID)
                    && s.rooms.has(key)
                ) {
                    try {
                        s.emit("refresh");
                        s.disconnect();
                    } catch (e) {}
                }
            }
            this.disconnected.push({ tenantId: Number(tenantId), userID: Number(userID) });
        },
    };

    // --- express app mirroring POST /api/switch-tenant ---
    const app = express();
    app.use(express.json());
    app.post("/api/switch-tenant", bearerAuth({ secretProvider: () => JWT_SECRET }), async (request, response) => {
        if (!request.user || !request.user.id) {
            response.status(401).json({ status: "fail", msg: "Unauthorized" });
            return;
        }
        const reference = request.body ? request.body.tenantId : null;
        if (reference == null || reference === "") {
            response.status(400).json({ status: "fail", msg: "Tenant not found." });
            return;
        }
        const tenant = await findTenantByIdOrSlug(reference);
        if (!tenant) {
            response.status(400).json({ status: "fail", msg: "Tenant not found." });
            return;
        }
        const role = await getMembershipRole(request.user.id, tenant.id);
        if (role == null) {
            response.status(403).json({ status: "fail", msg: "tenantAccessDenied", msgi18n: true });
            return;
        }
        const userBean = await R.findOne("user", " id = ? ", [ request.user.id ]);
        if (!userBean) {
            response.status(401).json({ status: "fail", msg: "Unauthorized" });
            return;
        }
        const token = User.createJWT(userBean, tenant.id, role, JWT_SECRET);
        response.json({
            ok: true,
            token,
            tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, role },
        });
    });

    httpAppServer = http.createServer(app);
    await new Promise((resolve) => httpAppServer.listen(0, "127.0.0.1", resolve));
    appPort = httpAppServer.address().port;
});

after(async () => {
    job.stopTenantMembershipCheckJob(null);
    if (ioServer) {
        await new Promise((resolve) => ioServer.close(resolve));
    }
    if (socketServer) {
        await new Promise((resolve) => socketServer.close(resolve));
    }
    if (httpAppServer) {
        await new Promise((resolve) => httpAppServer.close(resolve));
    }
    if (db) {
        await db.destroy();
    }
    if (dbPath) {
        removeTestDbFile(dbPath);
    }
});

describe("login flow", () => {

    test("returns ok with token, tenant list and activeTenantId; JWT tid/role match the active tenant", async () => {
        const client = await connectClient();

        const res = await emitAck(client, "login", { username: "alice", password: "correct-horse" });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.activeTenantId, TENANT_DEFAULT);
        assert.strictEqual(res.tenants.length, 2);
        const slugs = res.tenants.map((t) => t.slug).sort();
        assert.deepStrictEqual(slugs, [ "acme", "default" ]);

        const claims = decode(res.token);
        assert.strictEqual(claims.tid, res.activeTenantId);
        assert.strictEqual(claims.username, "alice");
        assert.ok(claims.role, "role claim must be present");
        assert.strictEqual(claims.role, "admin");

        client.disconnect();
    });

    test("wrong password is rejected", async () => {
        const client = await connectClient();
        const res = await emitAck(client, "login", { username: "alice", password: "wrong" });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.msg, "authIncorrectCreds");
        client.disconnect();
    });

    test("socket joins its tenant-partitioned rooms after login", async () => {
        const client = await connectClient();
        await emitAck(client, "login", { username: "alice", password: "correct-horse" });

        const sock = serverSide(client);
        assert.ok(sock.rooms.has(userRoom(TENANT_DEFAULT, aliceId)));
        assert.ok(sock.rooms.has(`t${TENANT_DEFAULT}`));

        client.disconnect();
    });
});

describe("switchTenant flow", () => {

    test("switches to the other tenant, reissues the JWT with the new tid and moves rooms", async () => {
        const client = await connectClient();
        await emitAck(client, "login", { username: "alice", password: "correct-horse" });

        const res = await emitAck(client, "switchTenant", TENANT_ACME);
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.activeTenantId, TENANT_ACME);

        const claims = decode(res.token);
        assert.strictEqual(claims.tid, TENANT_ACME);
        assert.strictEqual(claims.role, "viewer");

        const sock = serverSide(client);
        assert.strictEqual(sock.tenantID, TENANT_ACME);
        assert.ok(sock.rooms.has(userRoom(TENANT_ACME, aliceId)));
        assert.ok(sock.rooms.has(`t${TENANT_ACME}`));
        assert.ok(!sock.rooms.has(userRoom(TENANT_DEFAULT, aliceId)), "old user room must be left");
        assert.ok(!sock.rooms.has(`t${TENANT_DEFAULT}`), "old tenant room must be left");

        client.disconnect();
    });

    test("accepts the tenant slug as the target reference", async () => {
        const client = await connectClient();
        await emitAck(client, "login", { username: "alice", password: "correct-horse" });

        const res = await emitAck(client, "switchTenant", "acme");
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.activeTenantId, TENANT_ACME);

        client.disconnect();
    });

    test("denies a non-member target and leaves the session untouched", async () => {
        const client = await connectClient();
        await emitAck(client, "login", { username: "bob", password: "battery-staple" });

        const res = await emitAck(client, "switchTenant", TENANT_ACME);
        assert.strictEqual(res.ok, false);
        assert.match(res.msg, /access/i);

        const sock = serverSide(client);
        assert.strictEqual(sock.tenantID, TENANT_DEFAULT, "context stays on the original tenant");

        client.disconnect();
    });
});

describe("logout flow", () => {

    test("clears user/tenant context and leaves the tenant rooms", async () => {
        const client = await connectClient();
        await emitAck(client, "login", { username: "alice", password: "correct-horse" });

        let sock = serverSide(client);
        assert.ok(sock.rooms.has(userRoom(TENANT_DEFAULT, aliceId)));

        const res = await emitAck(client, "logout", undefined);
        assert.strictEqual(res, undefined, "logout acks with no payload");

        sock = serverSide(client);
        assert.strictEqual(sock.userID, null);
        assert.strictEqual(sock.tenantID, null);
        assert.ok(!sock.rooms.has(userRoom(TENANT_DEFAULT, aliceId)), "user room left on logout");
        assert.ok(!sock.rooms.has(`t${TENANT_DEFAULT}`), "tenant room left on logout");

        client.disconnect();
    });
});

describe("invalid tenant flow", () => {

    test("a forged tid for a non-member tenant falls back to the first accessible tenant and re-issues a clean token", async () => {
        const client = await connectClient();

        // Forge a token claiming alice is active in TENANT_GHOST, which she has no membership row for.
        const aliceRow = await db("user").where("username", "alice").first();
        const forged = jwt.sign(
            {
                username: "alice",
                h: shake256(aliceRow.password, SHAKE256_LENGTH),
                tid: TENANT_GHOST,
                role: "owner",
            },
            JWT_SECRET
        );

        const res = await emitAck(client, "loginByToken", forged);

        // task-09 contract: fallback fires — the session lands on the first
        // ACCESSIBLE tenant; the invalid tid never leaks into the context.
        assert.strictEqual(res.ok, true);
        assert.notStrictEqual(res.activeTenantId, TENANT_GHOST);
        assert.strictEqual(res.activeTenantId, TENANT_DEFAULT);

        const claims = decode(res.token);
        assert.strictEqual(claims.tid, TENANT_DEFAULT, "re-issued token carries the corrected tid");

        const sock = serverSide(client);
        assert.strictEqual(sock.tenantID, TENANT_DEFAULT);

        client.disconnect();
    });

    test("a garbage token is rejected outright", async () => {
        const client = await connectClient();
        const res = await emitAck(client, "loginByToken", "not-a-jwt");
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.msg, "authInvalidToken");
        client.disconnect();
    });
});

describe("HTTP POST /api/switch-tenant flow", () => {

    test("bearer-authenticated member gets a re-issued token for the target tenant", async () => {
        const client = await connectClient();
        const loginRes = await emitAck(client, "login", { username: "alice", password: "correct-horse" });
        client.disconnect();

        const response = await fetch(`http://127.0.0.1:${appPort}/api/switch-tenant`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${loginRes.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ tenantId: TENANT_ACME }),
        });
        assert.strictEqual(response.status, 200);

        const body = await response.json();
        assert.strictEqual(body.ok, true);
        assert.strictEqual(body.tenant.slug, "acme");
        assert.strictEqual(body.tenant.role, "viewer");

        const claims = decode(body.token);
        assert.strictEqual(claims.tid, TENANT_ACME);
    });

    test("a non-member is denied with tenantAccessDenied", async () => {
        const client = await connectClient();
        const loginRes = await emitAck(client, "login", { username: "bob", password: "battery-staple" });
        client.disconnect();

        const response = await fetch(`http://127.0.0.1:${appPort}/api/switch-tenant`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${loginRes.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ tenantId: TENANT_ACME }),
        });
        assert.strictEqual(response.status, 403);

        const body = await response.json();
        assert.strictEqual(body.msg, "tenantAccessDenied");
    });

    test("an invalid bearer token is rejected with 401 by the middleware", async () => {
        const response = await fetch(`http://127.0.0.1:${appPort}/api/switch-tenant`, {
            method: "POST",
            headers: {
                "Authorization": "Bearer bogus.token.value",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ tenantId: TENANT_ACME }),
        });
        assert.strictEqual(response.status, 401);
    });
});

describe("force-logout on removal (membership watchdog)", () => {

    test("removing a live user's membership emits forceLogoutTenant then disconnects every sibling session in that tenant only, after two consecutive misses", async () => {
        // Reset any transient job state between scenarios.
        job.stopTenantMembershipCheckJob(null);

        // Alice opens TWO sibling sessions in the default tenant; Bob keeps one.
        const aliceA = await connectClient();
        const aliceB = await connectClient();
        const bob = await connectClient();
        await emitAck(aliceA, "login", { username: "alice", password: "correct-horse" });
        await emitAck(aliceB, "login", { username: "alice", password: "correct-horse" });
        await emitAck(bob, "login", { username: "bob", password: "battery-staple" });

        /** @type {{client: string, payload: any}[]} */
        const events = [];
        for (const [ name, c ] of [ [ "aliceA", aliceA ], [ "aliceB", aliceB ] ]) {
            c.on("forceLogoutTenant", (payload) => events.push({ client: name, payload }));
        }
        const discA = waitForDisconnect(aliceA);
        const discB = waitForDisconnect(aliceB);

        // Admin removes Alice from the default tenant while both sessions are live.
        await db("tenant_user")
            .where("user_id", aliceId)
            .andWhere("tenant_id", TENANT_DEFAULT)
            .del();

        // Pass 1: first consecutive miss — flagged only, still connected
        // (race tolerance: an in-flight switch must not be cut mid-flight).
        const pass1 = await job.runOnce(global.__jobServerDouble);
        assert.strictEqual(pass1.revoked, 0);
        assert.strictEqual(pass1.flagged, 2);
        assert.strictEqual(events.length, 0);
        assert.strictEqual(aliceA.connected, true);
        assert.strictEqual(aliceB.connected, true);

        // Pass 2: confirmed revocation — force logout.
        const pass2 = await job.runOnce(global.__jobServerDouble);
        assert.strictEqual(pass2.revoked, 2);

        await Promise.all([ discA, discB ]);

        // Both siblings got the typed event with the revoked tenant id…
        assert.deepStrictEqual(events.map((e) => e.client).sort(), [ "aliceA", "aliceB" ]);
        for (const e of events) {
            assert.strictEqual(e.payload.tenantId, TENANT_DEFAULT);
        }

        // …the watchdog disconnected exactly the revoked (tenant, user) pair…
        assert.ok(
            global.__jobServerDouble.disconnected.some((d) =>
                d.tenantId === TENANT_DEFAULT && d.userID === aliceId
            ),
            "disconnectAllSocketClientsForTenant must be called for the revoked pair"
        );

        // …and Bob's unrelated session survives untouched.
        assert.strictEqual(bob.connected, true);
        assert.strictEqual(serverSide(bob).tenantID, TENANT_DEFAULT);

        bob.disconnect();
    });

    test("members in good standing and sessions in other tenants survive repeated ticks", async () => {
        job.stopTenantMembershipCheckJob(null);

        // Alice re-authenticates against ACME (she is still a member there);
        // Bob remains on the default tenant. Several passes must touch nobody.
        const aliceAcme = await connectClient();
        await emitAck(aliceAcme, "login", { username: "alice", password: "correct-horse" });
        await emitAck(aliceAcme, "switchTenant", TENANT_ACME);

        const bob = await connectClient();
        await emitAck(bob, "login", { username: "bob", password: "battery-staple" });

        for (let i = 0; i < 3; i++) {
            const stats = await job.runOnce(global.__jobServerDouble);
            assert.strictEqual(stats.flagged, 0, `pass ${i}: valid members must never be flagged`);
            assert.strictEqual(stats.revoked, 0, `pass ${i}: valid members must never be revoked`);
        }

        assert.strictEqual(aliceAcme.connected, true);
        assert.strictEqual(bob.connected, true);

        aliceAcme.disconnect();
        bob.disconnect();
    });

    test("unauthenticated sockets are ignored by the tick", async () => {
        job.stopTenantMembershipCheckJob(null);

        const anonymous = await connectClient();

        // The tick must only count authenticated sockets (userID + tenantID
        // set); whatever stragglers from earlier tests remain, the anonymous
        // connection contributes nothing and nothing gets flagged.
        const expectedAuthed = [ ...ioServer.of("/").sockets.values() ]
            .filter((s) => s.userID != null && s.tenantID != null).length;

        const stats = await job.runOnce(global.__jobServerDouble);
        assert.strictEqual(stats.checked, expectedAuthed);
        assert.strictEqual(stats.flagged, 0);
        assert.strictEqual(stats.revoked, 0);
        assert.strictEqual(anonymous.connected, true);
        anonymous.disconnect();
    });
});

describe("watchdog lifecycle", () => {

    test("start is idempotent, stop is always safe, restart yields a fresh token", () => {
        job.stopTenantMembershipCheckJob(null);

        const token1 = job.startTenantMembershipCheckJob(global.__jobServerDouble);
        const token2 = job.startTenantMembershipCheckJob(global.__jobServerDouble);
        assert.strictEqual(token1, token2, "second start returns the existing token");

        job.stopTenantMembershipCheckJob(token1);
        job.stopTenantMembershipCheckJob(null); // double-stop must not throw

        const token3 = job.startTenantMembershipCheckJob(global.__jobServerDouble);
        assert.notStrictEqual(token3, token1, "restart creates a fresh token");
        assert.ok(token3.generation > token1.generation, "token generation increases");
        assert.strictEqual(token3.intervalMs, token1.intervalMs);
        job.stopTenantMembershipCheckJob(token3);
    });

    test("interval is configurable via UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS with a 60s default", async () => {
        const prev = process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS;
        delete process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS;
        const defaultToken = job.startTenantMembershipCheckJob(global.__jobServerDouble);
        assert.strictEqual(defaultToken.intervalMs, 60000);
        job.stopTenantMembershipCheckJob(defaultToken);

        process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS = "250";
        const fastToken = job.startTenantMembershipCheckJob(global.__jobServerDouble);
        assert.strictEqual(fastToken.intervalMs, 250);
        job.stopTenantMembershipCheckJob(fastToken);

        // Invalid values fall back to the default instead of spinning.
        process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS = "-5";
        const badToken = job.startTenantMembershipCheckJob(global.__jobServerDouble);
        assert.strictEqual(badToken.intervalMs, 60000);
        job.stopTenantMembershipCheckJob(badToken);

        if (prev === undefined) {
            delete process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS;
        } else {
            process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS = prev;
        }
    });
});

describe("i18n contract", () => {

    test("src/lang/en.json ships the forceLogoutTenant message key", () => {
        const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../../src/lang/en.json"), "utf8"));
        assert.ok(typeof en.forceLogoutTenant === "string" && en.forceLogoutTenant.length > 0);
    });
});
