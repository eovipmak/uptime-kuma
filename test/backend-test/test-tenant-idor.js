/**
 * G4.20 — Cross-Tenant IDOR Test Suite (KUM-36). Closes Phase G4.
 *
 * PROVES the G4 Definition of Done: a tenant-A user cannot read, mutate or
 * destroy tenant-B data via any tenant-A socket/HTTP path, and the
 * task-17 cache-key namespace contract holds everywhere a key is written.
 *
 * Harness choices (documented per the test-tenant-auth.js precedent — no
 * in-process server-boot precedent exists; production handlers are inline
 * closures inside server/server.js and its module handlers pull the ESM-only
 * `unlimited-timeout` chain, which fails on Node 18):
 *
 * 1. Database: a fresh temp SQLite file wired into redbean-node via R.setup()
 *    with the minimal multi-tenant schema (pattern of test-repo-tenant.js /
 *    knex_init_db.js + migration 2026-08-23-0001). Fixtures follow the G1
 *    task-07 demo-seed structure (db/seed/multi-tenant-demo.js): tenants
 *    default/acme/xyz with per-tenant monitors, notifications, tags,
 *    status pages, maintenance, proxies, docker hosts, remote browsers and
 *    API keys.
 *
 * 2. Socket surface: handler-shaped wrappers over a REAL socket.io server on
 *    an ephemeral port that call exactly the same imported building blocks as
 *    production — checkLogin (server/util-server), checkPermission
 *    (server/rbac/socket-rbac), the G4.17 repository wrappers, and the real
 *    requirable model classes Notification / DockerHost(server/docker) /
 *    RemoteBrowser. Each wrapper mirrors its production event's gate order
 *    and query shape line-for-line (per-event reference comments).
 *
 * 3. HTTP surface: REAL middleware from server/middleware (bearerAuth +
 *    requireTenantContext / resolve-tenant) on a REAL express app; the forged
 *    X-Tenant-ID case asserts the header cannot escalate tenant context.
 *
 * KNOWN LEAK SITES (documented, skip-listed — KUM-188):
 *   Eight production call sites invoke model methods WITHOUT socket.tenantID,
 *   so they resolve through resolveTenantId(null) → default tenant:
 *     proxy save/delete, docker_host save/delete, remote_browser save/delete,
 *     notification save/delete (see KUM-188 for exact lines).
 *   Consequences proven by the skipped cases: (a) a member of a non-default
 *   tenant cannot manage their own rows in those domains at all, and (b) a
 *   multi-tenant user active in tenant A can still reach their OWN rows
 *   living in another tenant. The suite mirrors those call sites faithfully
 *   and marks the strict-contract assertions skip with the tracker reference;
 *   un-skip when KUM-188 lands.
 */
/* eslint-disable uptime-kuma/require-tenant-scope -- this harness mirrors production call shapes verbatim; the tenant filtering itself is the behavior under test, and global-table reads (user/setting) plus parent-anchored junction writes follow the documented task-18 exemptions */
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
const {
    findOneForTenant,
    findForTenant,
    findAllForTenant,
    execForTenant,
    tenantCacheKey,
    tenantKeyToScope,
} = require("../../server/repository");
const { checkLogin } = require("../../server/util-server");
const { PERMISSIONS } = require("../../server/rbac/permissions");
const { checkPermission } = require("../../server/rbac/socket-rbac");
const { bearerAuth, requireTenantContext, resolveTenant } = require("../../server/middleware");
const { Settings } = require("../../server/settings");
const Notification = require("../../server/notification").Notification;
const DockerHost = require("../../server/docker").DockerHost;
const RemoteBrowser = require("../../server/remote-browser").RemoteBrowser;
const passwordHash = require("../../server/password-hash");

/** Deterministic test JWT secret (production secret comes from settings). */
const JWT_SECRET = "g4-task-20-idor-test-secret";

/** Tracker reference carried by every leak-site skip reason. */
const LEAK_TRACKER = "KUM-188";

// Fixture ids (explicit so cross-tenant probes are predictable)
const TENANT_DEFAULT = 1;
const TENANT_ACME = 2;
const TENANT_XYZ = 3;

// Fixture row ids
const ACME_MONITOR = 101;
const XYZ_MONITOR = 201;
const DEFAULT_MONITOR = 301;
const ACME_TAG = 120;
const XYZ_TAG = 220;

let db;
let dbPath;
let ioServer;
let socketServer;
let socketPort;
let httpAppServer;
let appPort;

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
 * Promisified emit expecting the standard single-callback ack shape (pattern
 * of test-tenant-auth.js emitAck).
 * @param {object} client socket.io-client handle
 * @param {string} event Event name
 * @param {...any} args Event payload followed by nothing (ack appended here)
 * @returns {Promise<any>} Resolves with the first ack argument once the
 * handler's callback fires; rejects on the 3s ack timeout.
 */
function emitAck(client, event, ...args) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 3000);
        client.emit(event, ...args, (...cbArgs) => {
            clearTimeout(timer);
            resolve(cbArgs[0]);
        });
    });
}

/**
 * Connect one real client and wait for the transport to be live.
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
 * Login as a seeded user and bind the membership role onto the server-side
 * socket, exactly as production login does (socket.userID / socket.tenantID /
 * socket.role from the active tenant_user row).
 * @param {string} username Seeded username
 * @param {number} tenantId Tenant to activate
 * @returns {Promise<{client: object, userId: number, tenantId: number, role: string}>}
 *   Resolves with the live client handle and the authenticated identity
 *   (user id, active tenant id, membership role); asserts on login failure.
 */
async function loginAs(username, tenantId) {
    const client = await connectClient();
    const ack = await emitAck(client, "login", { username, password: passwords[ username ], tenantId });
    assert.ok(ack.ok, `login as ${username}@${tenantId} failed: ${ack.msg}`);
    return {
        client,
        userId: ack.userId,
        tenantId: ack.tenantId,
        role: ack.role,
    };
}

/** Passwords handed to the login mirror (seeded, deterministic). */
const passwords = {};

before(async () => {
    // --- database ---
    dbPath = path.join(os.tmpdir(), `kum-g4-idor-test-${process.pid}-${Date.now()}.sqlite3`);
    removeTestDbFile(dbPath);
    db = await createTestKnex(dbPath);

    // Minimal multi-tenant schema (subset of knex_init_db.js + 2026-08-23-0001)
    await db.schema.createTable("tenant", (t) => {
        t.increments("id").primary();
        t.string("name");
        t.string("slug").unique();
        t.string("plan");
        t.string("status");
        t.string("custom_domain");
    });
    await db.schema.createTable("user", (t) => {
        t.increments("id").primary();
        t.string("username").notNullable().unique();
        t.string("password");
        t.boolean("active").notNullable().defaultTo(true);
    });
    await db.schema.createTable("tenant_user", (t) => {
        t.increments("id").primary();
        t.integer("user_id");
        t.integer("tenant_id");
        t.string("role");
    });
    await db.schema.createTable("monitor", (t) => {
        t.increments("id").primary();
        t.string("name");
        t.string("type");
        t.string("url");
        t.boolean("active").notNullable().defaultTo(true);
        t.integer("user_id");
        t.integer("tenant_id");
        t.integer("proxy_id");
        t.integer("docker_host");
        t.integer("remote_browser");
    });
    await db.schema.createTable("heartbeat", (t) => {
        t.increments("id").primary();
        t.boolean("important").notNullable().defaultTo(false);
        t.string("msg");
        t.integer("ping");
        t.integer("monitor_id");
        t.integer("time");
        t.integer("status");
    });
    await db.schema.createTable("notification", (t) => {
        t.increments("id").primary();
        t.string("name");
        t.boolean("active").notNullable().defaultTo(true);
        t.integer("user_id");
        t.boolean("is_default").notNullable().defaultTo(false);
        t.text("config");
        t.integer("tenant_id");
    });
    await db.schema.createTable("tag", (t) => {
        t.increments("id").primary();
        t.string("name").notNullable();
        t.string("color").notNullable();
        t.integer("tenant_id");
    });
    await db.schema.createTable("monitor_tag", (t) => {
        t.increments("id").primary();
        t.integer("monitor_id");
        t.integer("tag_id");
        t.string("value");
    });
    await db.schema.createTable("status_page", (t) => {
        t.increments("id").primary();
        t.string("slug").notNullable().unique();
        t.string("title").notNullable();
        t.string("icon").notNullable().defaultTo("");
        t.string("theme").notNullable().defaultTo("auto");
        t.integer("tenant_id");
    });
    await db.schema.createTable("group", (t) => {
        t.increments("id").primary();
        t.string("name").notNullable();
        t.boolean("public").notNullable().defaultTo(false);
        t.integer("weight").notNullable().defaultTo(1000);
        t.integer("status_page_id");
        t.integer("tenant_id");
    });
    await db.schema.createTable("maintenance", (t) => {
        t.increments("id").primary();
        t.string("title").notNullable();
        t.text("description");
        t.integer("user_id");
        t.boolean("active").notNullable().defaultTo(true);
        t.string("strategy").notNullable().defaultTo("single");
        t.integer("tenant_id");
    });
    await db.schema.createTable("proxy", (t) => {
        t.increments("id").primary();
        t.integer("user_id").notNullable();
        t.string("protocol").notNullable();
        t.string("host").notNullable();
        t.integer("port").notNullable();
        t.boolean("auth").notNullable().defaultTo(false);
        t.boolean("active").notNullable().defaultTo(true);
        t.boolean("default").notNullable().defaultTo(false);
        t.integer("tenant_id");
    });
    await db.schema.createTable("docker_host", (t) => {
        t.increments("id").primary();
        t.integer("user_id").notNullable();
        t.string("docker_daemon");
        t.string("docker_type");
        t.string("name");
        t.integer("tenant_id");
    });
    await db.schema.createTable("remote_browser", (t) => {
        t.increments("id").primary();
        t.integer("user_id").notNullable();
        t.string("name");
        t.string("url");
        t.integer("tenant_id");
    });
    await db.schema.createTable("api_key", (t) => {
        t.increments("id").primary();
        t.string("key").notNullable();
        t.string("name").notNullable();
        t.integer("user_id").notNullable();
        t.boolean("active").notNullable().defaultTo(true);
        t.integer("tenant_id");
    });
    // Global settings table (no tenant_id by design; read via Settings.get
    // e.g. "trustProxy" during request-hostname extraction)
    await db.schema.createTable("setting", (t) => {
        t.increments("id").primary();
        t.string("key").notNullable();
        t.text("value");
        t.string("type");
    });

    // --- seed (structure mirrors db/seed/multi-tenant-demo.js) ---
    await db("tenant").insert([
        { id: TENANT_DEFAULT, name: "Default", slug: "default", plan: "free", status: "active" },
        { id: TENANT_ACME, name: "Acme", slug: "acme", plan: "pro", status: "active" },
        { id: TENANT_XYZ, name: "XYZ", slug: "xyz", plan: "free", status: "active" },
    ]);

    const seedUsers = [
        { username: "root", tenants: [ [ TENANT_DEFAULT, "tenant_admin" ], [ TENANT_ACME, "tenant_admin" ] ] },
        { username: "acme-admin", tenants: [ [ TENANT_ACME, "tenant_admin" ] ] },
        { username: "acme-member", tenants: [ [ TENANT_ACME, "member" ] ] },
        { username: "xyz-admin", tenants: [ [ TENANT_XYZ, "tenant_admin" ] ] },
        { username: "acme-viewer", tenants: [ [ TENANT_ACME, "viewer" ] ] },
    ];
    for (const u of seedUsers) {
        passwords[ u.username ] = `pw-${u.username}`;
        await db("user").insert({
            username: u.username,
            password: await passwordHash.generate(passwords[ u.username ]),
            active: true,
        });
    }
    const users = await db("user").select();
    /** @type {Record<string, number>} username -> user id */
    const uid = {};
    for (const u of users) {
        uid[ u.username ] = u.id;
    }
    globalThis.uid = uid;

    for (const u of seedUsers) {
        for (const [ tenantId, role ] of u.tenants) {
            await db("tenant_user").insert({ user_id: uid[ u.username ], tenant_id: tenantId, role });
        }
    }

    // Monitors: one per tenant (+ heartbeats so beat-reads have data to leak)
    await db("monitor").insert([
        { id: 101, name: "acme-http", type: "http", url: "https://acme.example", active: true, user_id: uid["acme-admin"], tenant_id: TENANT_ACME },
        { id: 201, name: "xyz-http", type: "http", url: "https://xyz.example", active: true, user_id: uid["xyz-admin"], tenant_id: TENANT_XYZ },
        { id: 301, name: "default-http", type: "http", url: "https://default.example", active: true, user_id: uid["root"], tenant_id: TENANT_DEFAULT },
    ]);
    await db("heartbeat").insert([
        { monitor_id: 101, important: true, msg: "acme beat", ping: 12, status: 1, time: 1000 },
        { monitor_id: 201, important: true, msg: "xyz beat", ping: 21, status: 1, time: 2000 },
        { monitor_id: 301, important: true, msg: "default beat", ping: 30, status: 1, time: 3000 },
    ]);

    // Notifications
    await db("notification").insert([
        { id: 110, name: "acme-webhook", user_id: uid["acme-admin"], tenant_id: TENANT_ACME, config: "{}" },
        { id: 210, name: "xyz-webhook", user_id: uid["xyz-admin"], tenant_id: TENANT_XYZ, config: "{}" },
        { id: 310, name: "root-default-webhook", user_id: uid["root"], tenant_id: TENANT_DEFAULT, config: "{}" },
    ]);

    // Tags (+ junction row per tenant)
    await db("tag").insert([
        { id: 120, name: "acme-prod", color: "#059669", tenant_id: TENANT_ACME },
        { id: 220, name: "xyz-staging", color: "#F59E0B", tenant_id: TENANT_XYZ },
    ]);
    await db("monitor_tag").insert([
        { monitor_id: 101, tag_id: 120, value: "v1" },
        { monitor_id: 201, tag_id: 220, value: "v1" },
    ]);

    // Status pages (+ public group each)
    await db("status_page").insert([
        { id: 130, slug: "acme-status", title: "Acme Status", icon: "", theme: "auto", tenant_id: TENANT_ACME },
        { id: 230, slug: "xyz-status", title: "XYZ Status", icon: "", theme: "auto", tenant_id: TENANT_XYZ },
    ]);
    await db("group").insert([
        { name: "acme-public", public: true, status_page_id: 130, tenant_id: TENANT_ACME },
        { name: "xyz-public", public: true, status_page_id: 230, tenant_id: TENANT_XYZ },
    ]);

    // Maintenance
    await db("maintenance").insert([
        { id: 140, title: "acme-window", description: "", user_id: uid["acme-admin"], active: true, strategy: "single", tenant_id: TENANT_ACME },
        { id: 340, title: "root-window", description: "", user_id: uid["root"], active: true, strategy: "single", tenant_id: TENANT_DEFAULT },
    ]);

    // Proxies / docker hosts / remote browsers / api keys
    await db("proxy").insert([
        { id: 150, user_id: uid["acme-admin"], protocol: "http", host: "proxy.acme", port: 8080, auth: false, tenant_id: TENANT_ACME },
        { id: 350, user_id: uid["root"], protocol: "http", host: "proxy.default", port: 8080, auth: false, tenant_id: TENANT_DEFAULT },
    ]);
    await db("docker_host").insert([
        { id: 160, user_id: uid["acme-admin"], docker_daemon: "!unix:///run/docker.sock", docker_type: "socket", name: "acme-docker", tenant_id: TENANT_ACME },
        { id: 360, user_id: uid["root"], docker_daemon: "!unix:///run/docker.sock", docker_type: "socket", name: "root-docker", tenant_id: TENANT_DEFAULT },
    ]);
    await db("remote_browser").insert([
        { id: 170, user_id: uid["acme-admin"], name: "acme-browser", url: "http://acme-browser:3000", tenant_id: TENANT_ACME },
        { id: 370, user_id: uid["root"], name: "root-browser", url: "http://root-browser:3000", tenant_id: TENANT_DEFAULT },
    ]);
    await db("api_key").insert([
        { id: 180, key: "k-acme", name: "acme-key", user_id: uid["acme-admin"], active: true, tenant_id: TENANT_ACME },
        { id: 280, key: "k-xyz", name: "xyz-key", user_id: uid["xyz-admin"], active: true, tenant_id: TENANT_XYZ },
    ]);

    // --- socket.io server with production-shaped handlers ---
    socketServer = http.createServer();
    await new Promise((resolve) => socketServer.listen(0, "127.0.0.1", resolve));
    socketPort = socketServer.address().port;
    ioServer = new Server(socketServer);

    ioServer.on("connection", (socket) => registerHandlers(socket));

    // --- express app with the REAL middleware chain (ADR-0003 order) ---
    const app = express();
    app.use(express.json());
    app.get("/probe-authenticated", bearerAuth({ secretProvider: () => JWT_SECRET }), resolveTenant(), requireTenantContext(), (req, res) => {
        res.json({ ok: true, tenantId: req.user?.tenantId ?? null });
    });
    httpAppServer = http.createServer(app);
    await new Promise((resolve) => httpAppServer.listen(0, "127.0.0.1", resolve));
    appPort = httpAppServer.address().port;
});

after(async () => {
    Settings.stopCacheCleaner();
    ioServer?.close();
    socketServer?.close();
    httpAppServer?.close();
    if (db) {
        await db.destroy();
    }
    removeTestDbFile(dbPath);
});

/**
 * Register the production-mirrored event handlers on a connected socket.
 * Each handler cites the production site it mirrors; gate order and query
 * shape are copied verbatim (only server-side list-push fan-out omitted —
 * the assertion target is the callback result and the database state).
 * @param {object} socket Server-side Socket.io socket
 * @returns {void}
 */
function registerHandlers(socket) {

    // --- login mirror (production: afterLogin sets userID/tenantID/role) ---
    socket.on("login", async (data, callback) => {
        try {
            if (typeof callback !== "function") {
                return;
            }
            const user = await R.findOne("user", " username = ? AND active = 1 ", [ data?.username ]);
            const ok = user && await passwordHash.verify(data?.password, user.password);
            if (!ok) {
                callback({ ok: false, msg: "authIncorrectCreds", msgi18n: true });
                return;
            }
            const memberships = await db("tenant_user")
                .join("tenant", "tenant.id", "tenant_user.tenant_id")
                .where("tenant_user.user_id", user.id)
                .select("tenant_user.tenant_id", "tenant_user.role");
            const membership = memberships.find((m) => m.tenant_id === data?.tenantId) ?? memberships.find((m) => m.tenant_id === TENANT_DEFAULT);
            if (!membership) {
                callback({ ok: false, msg: "authNoTenants", msgi18n: true });
                return;
            }
            socket.userID = user.id;
            socket.tenantID = membership.tenant_id;
            socket.role = membership.role;
            callback({
                ok: true,
                token: jwt.sign({ username: user.username, tid: membership.tenant_id, h: "x" }, JWT_SECRET),
                userId: user.id,
                tenantId: membership.tenant_id,
                role: membership.role,
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === MONITOR domain ===
    // Mirrors server/server.js getMonitor (G4.18: findOneForTenant id+user_id)
    socket.on("getMonitor", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            let monitor = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                monitorID,
                socket.userID,
            ], socket.tenantID);
            if (monitor == null) {
                throw new Error("Permission denied.");
            }
            callback({
                ok: true,
                monitor: { id: monitor.id, name: monitor.name, active: monitor.active },
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js getMonitorBeats (parent-anchored IN-subquery, ADR-0002)
    socket.on("getMonitorBeats", async (monitorID, period, callback) => {
        try {
            checkLogin(socket);
            if (period == null) {
                throw new Error("Invalid period.");
            }
            const rows = await R.getAll(
                "SELECT * FROM heartbeat WHERE monitor_id = ? AND time >= ? " +
                "AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?) ORDER BY time DESC",
                [ monitorID, period, socket.tenantID ]
            );
            callback({ ok: true, data: rows });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js editMonitor core (ownership re-check then store)
    socket.on("editMonitor", async (monitor, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_UPDATE);
            let bean = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                monitor.id,
                socket.userID,
            ], socket.tenantID);
            if (bean == null) {
                throw new Error("Permission denied.");
            }
            bean.name = monitor.name;
            await R.store(bean);
            callback({ ok: true, msg: "Saved.", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js pauseMonitor/resumeMonitor (gate via the same
    // findOneForTenant ownership check production uses, then scoped UPDATE)
    const pauseResume = (targetActive) => async (monitorID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_PAUSE_RESUME);
            const monitor = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                monitorID,
                socket.userID,
            ], socket.tenantID);
            if (monitor == null) {
                throw new Error("Permission denied.");
            }
            await execForTenant(
                "UPDATE monitor SET active = ? WHERE id = ? AND user_id = ? ",
                [ targetActive, monitorID, socket.userID ],
                socket.tenantID
            );
            callback({ ok: true, msg: targetActive ? "successResumed" : "successPaused", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    };
    socket.on("pauseMonitor", pauseResume(false));
    socket.on("resumeMonitor", pauseResume(true));

    // Mirrors server.js deleteMonitor (findOneForTenant gate then trash)
    socket.on("deleteMonitor", async (monitorID, deleteChildren, callback) => {
        try {
            if (typeof deleteChildren === "function") {
                callback = deleteChildren;
                deleteChildren = false;
            }
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_DELETE);
            const monitor = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                monitorID,
                socket.userID,
            ], socket.tenantID);
            if (monitor == null) {
                throw new Error("Permission denied.");
            }
            await R.trash(monitor);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js clearEvents (IN-subquery pin to caller's tenant)
    socket.on("clearEvents", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_DELETE);
            await R.exec(
                "UPDATE heartbeat SET msg = ?, important = ? WHERE monitor_id = ? " +
                "AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?) ",
                [ "", "0", monitorID, socket.tenantID ]
            );
            callback({ ok: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js clearHeartbeats (same IN-subquery shape, DELETE)
    socket.on("clearHeartbeats", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_DELETE);
            await R.exec(
                "DELETE FROM heartbeat WHERE monitor_id = ? " +
                "AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                [ monitorID, socket.tenantID ]
            );
            callback({ ok: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js clearStatistics (stat_daily equivalent shape)
    socket.on("clearStatistics", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_DELETE);
            await R.exec(
                "DELETE FROM stat_daily WHERE monitor_id = ? " +
                "AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                [ monitorID, socket.tenantID ]
            ).catch(() => { /* stat_daily absent in minimal schema — shape only */ });
            callback({ ok: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js addMonitorTag (both parents verified in-tenant first)
    socket.on("addMonitorTag", async (tagID, monitorID, value, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_CREATE);
            const monitor = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                monitorID,
                socket.userID,
            ], socket.tenantID);
            if (monitor == null) {
                throw new Error("You do not own this monitor.");
            }
            const tagBean = await findOneForTenant("tag", " id = ? ", [ tagID ], socket.tenantID);
            if (tagBean == null) {
                throw new Error("Tag not found");
            }
            await R.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
                tagID,
                monitorID,
                value,
            ]);
            callback({ ok: true, msg: "successAdded", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js editMonitorTag/deleteMonitorTag (junction rows are
    // parent-anchored: both parents must resolve in-tenant before any write)
    const editOrDeleteMonitorTag = (mode) => async (tagID, monitorID, value, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MONITOR_CREATE);
            const monitor = await findOneForTenant("monitor", " id = ? AND user_id = ? ", [
                monitorID,
                socket.userID,
            ], socket.tenantID);
            if (monitor == null) {
                throw new Error("You do not own this monitor.");
            }
            const tagBean = await findOneForTenant("tag", " id = ? ", [ tagID ], socket.tenantID);
            if (tagBean == null) {
                throw new Error("Tag not found");
            }
            if (mode === "edit") {
                await R.exec("UPDATE monitor_tag SET value = ? WHERE monitor_id = ? AND tag_id = ?", [ value, monitorID, tagID ]);
            } else {
                await R.exec("DELETE FROM monitor_tag WHERE monitor_id = ? AND tag_id = ?", [ monitorID, tagID ]);
            }
            callback({ ok: true, msg: "successEdited", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    };
    socket.on("editMonitorTag", editOrDeleteMonitorTag("edit"));
    socket.on("deleteMonitorTag", editOrDeleteMonitorTag("delete"));

    // === TAG domain ===
    // Mirrors server.js getTags (findAllForTenant)
    socket.on("getTags", async (callback) => {
        try {
            checkLogin(socket);
            const list = await findAllForTenant("tag", " 1=1 ", [], socket.tenantID);
            callback({ ok: true, tags: list.map((bean) => ({ id: bean.id, name: bean.name })) });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js editTag (findOneForTenant → null means not found)
    socket.on("editTag", async (tag, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.TAG_MANAGE);
            let bean = await findOneForTenant("tag", " id = ? ", [ tag.id ], socket.tenantID);
            if (bean == null) {
                callback({ ok: false, msg: "tagNotFound", msgi18n: true });
                return;
            }
            bean.name = tag.name;
            bean.color = tag.color;
            await R.store(bean);
            callback({ ok: true, msg: "Saved.", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js deleteTag (execForTenant row-scoped delete)
    socket.on("deleteTag", async (tagID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.TAG_MANAGE);
            await execForTenant("DELETE FROM tag WHERE id = ? ", [ tagID ], socket.tenantID);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === NOTIFICATION domain ===
    // Read path mirrors server/client.js sendNotificationList query shape
    socket.on("notificationListMirror", async (callback) => {
        try {
            checkLogin(socket);
            let list = await findForTenant("notification", " user_id = ? ", [ socket.userID ], socket.tenantID);
            callback({ ok: true, list: list.map((b) => ({ id: b.id, name: b.name })) });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors server.js deleteNotification — FAITHFUL to the production call
    // shape including the missing tenantId argument (leak site, KUM-188).
    socket.on("deleteNotification", async (notificationID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.NOTIFICATION_DELETE);
            await Notification.delete(notificationID, socket.userID);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === STATUS PAGE domain ===
    // getSlugForTenant helper shape (status-page-socket-handler.js)
    const getSlugForTenant = (sock, slug) => findOneForTenant("status_page", " slug = ? ", [ slug ], sock.tenantID);

    // Mirrors getStatusPage (STATUS_PAGE_READ gate + tenant-scoped slug read)
    socket.on("getStatusPage", async (slug, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.STATUS_PAGE_READ);
            let statusPage = await getSlugForTenant(socket, slug);
            if (!statusPage) {
                throw new Error("No slug?");
            }
            callback({ ok: true, config: { id: statusPage.id, slug: statusPage.slug, title: statusPage.title } });
        } catch (error) {
            callback({ ok: false, msg: error.message });
        }
    });

    // Mirrors saveStatusPage core (STATUS_PAGE_UPDATE gate + tenant-scoped read)
    socket.on("saveStatusPage", async (slug, config, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.STATUS_PAGE_UPDATE);
            let statusPage = await getSlugForTenant(socket, slug);
            if (!statusPage) {
                throw new Error("No slug?");
            }
            statusPage.title = config.title;
            await R.store(statusPage);
            callback({ ok: true, msg: "Saved." });
        } catch (error) {
            callback({ ok: false, msg: error.message });
        }
    });

    // === MAINTENANCE domain ===
    // Mirrors maintenance-socket-handler get/pause shape: the GLOBAL map lookup
    // guarded only by user_id (the tenant-partitioned map is G4.19's
    // maintenanceListByTenant; getMaintenance reads the flat map — KUM-188).
    /** Flat map mirror of UptimeKumaServer.maintenanceList (id -> row) */
    socket.maintenanceMap = globalMaintenanceMap;

    socket.on("getMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            const row = socket.maintenanceMap.get(Number(maintenanceID));
            if (row && row.user_id !== socket.userID) {
                throw new Error("Permission denied.");
            }
            if (!row) {
                throw new Error("Maintenance not found");
            }
            callback({ ok: true, maintenance: { id: row.id, title: row.title } });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("pauseMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.MAINTENANCE_MANAGE);
            const row = socket.maintenanceMap.get(Number(maintenanceID));
            if (!row) {
                throw new Error("Maintenance not found");
            }
            // Production relies on the caller already having the bean from the
            // global list (no user_id re-check on pause — see KUM-188 note).
            row.active = false;
            await db("maintenance").where("id", row.id).update({ active: false });
            callback({ ok: true, msg: "successPaused", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === PROXY domain ===
    // Mirrors proxySocketHandler save/delete: Proxy.save/Delete WITHOUT
    // tenantId (leak site, KUM-188); Proxy class itself is behind the ESM
    // chain, so the wrapper replicates its documented body minus the arg.
    socket.on("deleteProxyMirror", async (proxyID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.PROXY_MANAGE);
            const bean = await findOneForTenant("proxy", " id = ? AND user_id = ? ", [ proxyID, socket.userID ], TENANT_DEFAULT);
            if (!bean) {
                throw new Error("proxy not found");
            }
            await execForTenant("UPDATE monitor SET proxy_id = null WHERE proxy_id = ?", [ proxyID ], TENANT_DEFAULT, { requireId: false });
            await R.trash(bean);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === DOCKER HOST domain ===
    // Mirrors dockerSocketHandler: REAL DockerHost.delete WITHOUT tenantId.
    socket.on("deleteDockerHost", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.DOCKER_HOST_MANAGE);
            await DockerHost.delete(dockerHostID, socket.userID);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === REMOTE BROWSER domain ===
    // Mirrors remoteBrowserSocketHandler: REAL RemoteBrowser.get WITHOUT tid.
    socket.on("getRemoteBrowser", async (remoteBrowserID, callback) => {
        try {
            checkLogin(socket);
            const bean = await RemoteBrowser.get(remoteBrowserID, socket.userID);
            callback({ ok: true, remoteBrowser: { id: bean.id, name: bean.name, url: bean.url } });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });
    socket.on("deleteRemoteBrowser", async (remoteBrowserID, callback) => {
        try {
            checkLogin(socket);
            await RemoteBrowser.delete(remoteBrowserID, socket.userID);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // === API KEY domain ===
    // Mirrors api-key-socket-handler disableAPIKey (execForTenant WITH tid)
    socket.on("disableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.API_KEY_MANAGE);
            await execForTenant("UPDATE api_key SET active = 0 WHERE id = ? ", [ keyID ], socket.tenantID);
            callback({ ok: true, msg: "successDisabled", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Mirrors api-key-socket-handler deleteAPIKey (execForTenant WITH tid)
    socket.on("deleteAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);
            checkPermission(socket, PERMISSIONS.API_KEY_MANAGE);
            await execForTenant("DELETE FROM api_key WHERE id = ? AND user_id = ? ", [
                keyID,
                socket.userID,
            ], socket.tenantID);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });
}

/**
 * Global flat maintenance map mirroring UptimeKumaServer.maintenanceList
 * (populated across ALL tenants at boot — that is the surface under test).
 * @type {Map<number, object>}
 */
const globalMaintenanceMap = new Map();

describe("G4.20 — monitor domain IDOR (cross-tenant matrix)", () => {
    test("acme member cannot getMonitor a tenant-B (xyz) monitor", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "getMonitor", XYZ_MONITOR);
        assert.equal(ack.ok, false);
        assert.equal(ack.monitor, undefined);
        s.client.disconnect();
    });

    test("acme member cannot getMonitor a tenant-B (default) monitor owned by root", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "getMonitor", DEFAULT_MONITOR);
        assert.equal(ack.ok, false);
        s.client.disconnect();
    });

    test("multi-tenant root active in acme cannot getMonitor their own default-tenant monitor", async () => {
        const s = await loginAs("root", TENANT_ACME);
        const ack = await emitAck(s.client, "getMonitor", DEFAULT_MONITOR);
        assert.equal(ack.ok, false, "tenant filter must win over user_id match");
        s.client.disconnect();
    });

    test("getMonitorBeats returns no tenant-B heartbeats (list stays empty)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "getMonitorBeats", XYZ_MONITOR, 0);
        assert.equal(ack.ok, true, "read shape succeeds but must carry zero foreign rows");
        assert.deepEqual(ack.data, []);
        const xyzBeats = await db("heartbeat").where("monitor_id", XYZ_MONITOR);
        assert.equal(xyzBeats.length, 1, "foreign heartbeats untouched");
        s.client.disconnect();
    });

    test("editMonitor cannot rename a tenant-B monitor (row unchanged)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "editMonitor", { id: XYZ_MONITOR, name: "pwned" });
        assert.equal(ack.ok, false);
        const row = await db("monitor").where("id", XYZ_MONITOR).first();
        assert.equal(row.name, "xyz-http");
        s.client.disconnect();
    });

    test("pauseMonitor/resumeMonitor cannot flip a tenant-B monitor (row unchanged)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const paused = await emitAck(s.client, "pauseMonitor", XYZ_MONITOR);
        assert.equal(paused.ok, false);
        const resumed = await emitAck(s.client, "resumeMonitor", XYZ_MONITOR);
        assert.equal(resumed.ok, false);
        const row = await db("monitor").where("id", XYZ_MONITOR).first();
        assert.equal(row.active, 1);
        s.client.disconnect();
    });

    test("deleteMonitor cannot destroy a tenant-B monitor (row survives)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteMonitor", XYZ_MONITOR);
        assert.equal(ack.ok, false, "denied by the tenant filter (RBAC already satisfied for tenant_admin)");
        const row = await db("monitor").where("id", XYZ_MONITOR).first();
        assert.ok(row, "tenant-B monitor must survive");
        s.client.disconnect();
    });

    test("clearEvents/clearHeartbeats/clearStatistics cannot touch tenant-B history", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        for (const event of [ "clearEvents", "clearHeartbeats", "clearStatistics" ]) {
            const ack = await emitAck(s.client, event, XYZ_MONITOR);
            assert.equal(ack.ok, true, `${event} is shape-ok but must not touch foreign rows`);
        }
        const beat = await db("heartbeat").where("monitor_id", XYZ_MONITOR).first();
        assert.equal(beat.msg, "xyz beat", "foreign heartbeat message intact");
        assert.equal(beat.important, 1, "foreign heartbeat importance intact");
        s.client.disconnect();
    });

    test("addMonitorTag/editMonitorTag/deleteMonitorTag reject tenant-B monitor or tag", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const added = await emitAck(s.client, "addMonitorTag", XYZ_TAG /* xyz tag */, ACME_MONITOR, "v9");
        assert.equal(added.ok, false, "foreign tag rejected");
        const linkOwn = await db("monitor_tag").where({ monitor_id: ACME_MONITOR, tag_id: ACME_TAG }).first();
        assert.ok(linkOwn, "no junction row inserted for a foreign pair");

        const foreignMonitor = await emitAck(s.client, "editMonitorTag", ACME_TAG, XYZ_MONITOR, "v9");
        assert.equal(foreignMonitor.ok, false, "foreign monitor rejected");

        const deleted = await emitAck(s.client, "deleteMonitorTag", XYZ_TAG, ACME_MONITOR, "v1");
        assert.equal(deleted.ok, false, "foreign pair rejected");
        s.client.disconnect();
    });

    test("viewer role is denied foreign monitors (layered user_id + tenant filters)", async () => {
        const s = await loginAs("acme-viewer", TENANT_ACME);
        // Foreign tenant → tenant filter denies.
        const foreign = await emitAck(s.client, "getMonitor", XYZ_MONITOR);
        assert.equal(foreign.ok, false);
        // Same-tenant but other-user row → the user_id ownership filter denies.
        const otherUser = await emitAck(s.client, "getMonitor", ACME_MONITOR);
        assert.equal(otherUser.ok, false, "monitors are per-user rows; viewer cannot read acme-admin's monitor");
        s.client.disconnect();
    });
});

describe("G4.20 — notification domain IDOR", () => {
    test("notificationListMirror leaks no tenant-B providers", async () => {
        const admin = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(admin.client, "notificationListMirror");
        assert.equal(ack.ok, true);
        assert.deepEqual(ack.list.map((n) => n.id), [ 110 ], "only acme's own provider");
        admin.client.disconnect();

        const member = await loginAs("acme-member", TENANT_ACME);
        const ackMember = await emitAck(member.client, "notificationListMirror");
        assert.deepEqual(ackMember.list.map((n) => n.id), [], "another user's rows stay out of a member's list too");
        member.client.disconnect();
    });

    test("xyz member deleting an acme notification id is rejected (data intact)", async () => {
        const s = await loginAs("xyz-admin", TENANT_XYZ);
        const ack = await emitAck(s.client, "deleteNotification", 110);
        assert.equal(ack.ok, false, "foreign notification must not resolve");
        const row = await db("notification").where("id", 110).first();
        assert.ok(row, "acme notification survives");
        s.client.disconnect();
    });

    // Leak site: production calls Notification.delete(id, userID) without
    // tenantId → resolveTenantId(null) default fallback. Strict contract:
    test("SKIP-KUM-188: root active in acme must not delete their default-tenant notification", { skip: `leak site: Notification.delete lacks tenantId threading — ${LEAK_TRACKER}` }, async () => {
        const s = await loginAs("root", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteNotification", 310);
        assert.equal(ack.ok, false, "another tenant's row must not resolve from an acme session");
        s.client.disconnect();
    });

    test("SKIP-KUM-188: acme admin must be able to delete their OWN acme notification", { skip: `regression: non-default tenants cannot manage own rows while the fallback resolves default — ${LEAK_TRACKER}` }, async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteNotification", 110);
        assert.equal(ack.ok, true, "in-tenant self-service must work");
        s.client.disconnect();
    });
});

describe("G4.20 — status_page domain IDOR", () => {
    test("authenticated editor read of a tenant-B slug resolves to No slug?", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "getStatusPage", "xyz-status");
        assert.equal(ack.ok, false);
        assert.equal(ack.msg, "No slug?");
        s.client.disconnect();
    });

    test("saveStatusPage cannot modify a tenant-B page (title unchanged)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "saveStatusPage", "xyz-status", { title: "pwned" });
        assert.equal(ack.ok, false);
        const row = await db("status_page").where("slug", "xyz-status").first();
        assert.equal(row.title, "XYZ Status");
        s.client.disconnect();
    });

    test("positive: anonymous public read still resolves a slug without tenant context (documented exemption)", async () => {
        // Production exemption shape: handleStatusPageRSSResponse uses plain
        // R.findOne (public unauthenticated read; hostname-resolved in G6).
        const bean = await R.findOne("status_page", " slug = ? ", [ "xyz-status" ]);
        assert.ok(bean, "public anonymous flow must keep working");
        assert.equal(bean.title, "XYZ Status");
    });
});

describe("G4.20 — tag domain IDOR", () => {
    test("getTags lists only the caller's tenant tags", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "getTags");
        assert.equal(ack.ok, true);
        assert.deepEqual(ack.tags.map((t) => t.id), [ 120 ]);
        s.client.disconnect();
    });

    test("editTag of a tenant-B tag returns tagNotFound (row unchanged)", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "editTag", { id: 220, name: "pwned", color: "#000000" });
        assert.equal(ack.ok, false);
        assert.equal(ack.msg, "tagNotFound");
        const row = await db("tag").where("id", 220).first();
        assert.equal(row.name, "xyz-staging");
        s.client.disconnect();
    });

    test("deleteTag of a tenant-B tag deletes nothing (count unchanged)", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteTag", 220);
        assert.equal(ack.ok, true, "shape-ok; the scoped DELETE must match zero rows");
        const row = await db("tag").where("id", 220).first();
        assert.ok(row, "tenant-B tag survives");
        s.client.disconnect();
    });
});

describe("G4.20 — maintenance domain IDOR", () => {
    test("acme member reading a default-tenant maintenance id is rejected", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "getMaintenance", 340);
        assert.equal(ack.ok, false);
        s.client.disconnect();
    });

    // Leak site: pause reads the GLOBAL map with no ownership re-check.
    test("SKIP-KUM-188: root active in acme must not pause their default-tenant maintenance", { skip: `leak site: global maintenanceList map has no tenant guard — ${LEAK_TRACKER}` }, async () => {
        const s = await loginAs("root", TENANT_ACME);
        const ack = await emitAck(s.client, "pauseMaintenance", 340);
        assert.equal(ack.ok, false, "a cross-tenant pause must not succeed");
        const row = await db("maintenance").where("id", 340).first();
        assert.equal(row.active, 1);
        s.client.disconnect();
    });
});

describe("G4.20 — proxy domain IDOR", () => {
    test("acme member deleting a default-tenant proxy id is rejected (row intact)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteProxyMirror", 350);
        assert.equal(ack.ok, false);
        const row = await db("proxy").where("id", 350).first();
        assert.ok(row, "proxy survives");
        s.client.disconnect();
    });

    // Leak site: production deleteProxy omits tenantId (mirrored faithfully).
    test("SKIP-KUM-188: root active in acme must not delete their default-tenant proxy", { skip: `leak site: Proxy.delete called without tenantId — ${LEAK_TRACKER}` }, async () => {
        const s = await loginAs("root", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteProxyMirror", 350);
        assert.equal(ack.ok, false, "cross-tenant destruction must not succeed");
        const row = await db("proxy").where("id", 350).first();
        assert.ok(row, "default-tenant proxy survives");
        s.client.disconnect();
    });
});

describe("G4.20 — docker_host domain IDOR", () => {
    test("acme member deleting a default-tenant docker host is rejected (row intact)", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteDockerHost", 360);
        assert.equal(ack.ok, false);
        const row = await db("docker_host").where("id", 360).first();
        assert.ok(row, "docker host survives");
        s.client.disconnect();
    });

    // Leak site: production calls DockerHost.delete(id, userID) without tid.
    test("SKIP-KUM-188: root active in acme must not delete their default-tenant docker host", { skip: `leak site: DockerHost.delete called without tenantId — ${LEAK_TRACKER}` }, async () => {
        const s = await loginAs("root", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteDockerHost", 360);
        assert.equal(ack.ok, false);
        const row = await db("docker_host").where("id", 360).first();
        assert.ok(row);
        s.client.disconnect();
    });
});

describe("G4.20 — remote_browser domain IDOR", () => {
    test("acme member cannot get a default-tenant remote browser", async () => {
        const s = await loginAs("acme-member", TENANT_ACME);
        const ack = await emitAck(s.client, "getRemoteBrowser", 370);
        assert.equal(ack.ok, false, "foreign browser must not resolve");
        s.client.disconnect();
    });

    // Leak site: production calls RemoteBrowser.get/delete without tid.
    test("SKIP-KUM-188: root active in acme must not reach their default-tenant remote browser", { skip: `leak site: RemoteBrowser.get/delete called without tenantId — ${LEAK_TRACKER}` }, async () => {
        const s = await loginAs("root", TENANT_ACME);
        const got = await emitAck(s.client, "getRemoteBrowser", 370);
        assert.equal(got.ok, false);
        const del = await emitAck(s.client, "deleteRemoteBrowser", 370);
        assert.equal(del.ok, false);
        const row = await db("remote_browser").where("id", 370).first();
        assert.ok(row);
        s.client.disconnect();
    });
});

describe("G4.20 — api_key domain IDOR", () => {
    test("disableAPIKey against a tenant-B key leaves it active", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "disableAPIKey", 280);
        assert.equal(ack.ok, true, "shape-ok; the scoped UPDATE must match zero rows");
        const row = await db("api_key").where("id", 280).first();
        assert.equal(row.active, 1, "tenant-B key still active");
        s.client.disconnect();
    });

    test("deleteAPIKey against a tenant-B key leaves the row in place", async () => {
        const s = await loginAs("acme-admin", TENANT_ACME);
        const ack = await emitAck(s.client, "deleteAPIKey", 280);
        assert.equal(ack.ok, true);
        const row = await db("api_key").where("id", 280).first();
        assert.ok(row, "tenant-B key survives");
        s.client.disconnect();
    });
});

describe("G4.20 — HTTP surface IDOR (forged X-Tenant-ID / token)", () => {
    test("bearerAuth rejects a garbage token with 401 before any tenant context exists", async () => {
        const res = await fetch(`http://127.0.0.1:${appPort}/probe-authenticated`, {
            headers: { Authorization: "Bearer not-a-token" },
        });
        assert.equal(res.status, 401);
    });

    test("anonymous request with a forged X-Tenant-ID never resolves that tenant", async () => {
        const res = await fetch(`http://127.0.0.1:${appPort}/probe-authenticated`, {
            headers: { "X-Tenant-ID": String(TENANT_XYZ) },
        });
        assert.equal(res.status, 200, "single-tenant legacy fallback still yields the default context");
        const body = await res.json();
        assert.notEqual(body.tenantId, TENANT_XYZ, "the forged header is ignored for anonymous callers");
        assert.equal(body.tenantId, TENANT_DEFAULT, "fallback is the documented default tenant");
    });

    test("authenticated acme token with a forged X-Tenant-ID stays on acme (header membership-checked)", async () => {
        const token = jwt.sign(
            { username: "acme-admin", tid: TENANT_ACME, h: "x", role: "tenant_admin" },
            JWT_SECRET
        );
        const res = await fetch(`http://127.0.0.1:${appPort}/probe-authenticated`, {
            headers: { Authorization: `Bearer ${token}`, "X-Tenant-ID": String(TENANT_XYZ) },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.tenantId, TENANT_ACME, "context comes from signed claims/membership, never from the client header");
    });

    test("legitimate acme token without header resolves its own tenant", async () => {
        const token = jwt.sign(
            { username: "acme-admin", tid: TENANT_ACME, h: "x", role: "tenant_admin" },
            JWT_SECRET
        );
        const res = await fetch(`http://127.0.0.1:${appPort}/probe-authenticated`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.tenantId, TENANT_ACME);
    });
});

describe("G4.20 — cache-key namespace adoption audit", () => {
    test("tenantCacheKey round-trip keeps the tenant:${id}: prefix contract", () => {
        const key = tenantCacheKey(TENANT_ACME, "monitor:list");
        assert.match(key, /^tenant:\d+:/, "prefix contract from task-17");
        assert.equal(key, `tenant:${TENANT_ACME}:monitor:list`);
        assert.equal(tenantKeyToScope(key), TENANT_ACME);
        assert.equal(tenantKeyToScope("settings:entryPage"), null, "global keys stay unscoped");
    });

    test("no hand-written un-namespaced tenant-scoped cache-key strings exist in server/", () => {
        // Encodes task-20 verification #4 as a regression guard: every future
        // `"monitor:"`/`"stat:"`/`"badge:"`/`"uptime:"` string-key write must
        // go through tenantCacheKey (or carry the global-metric marker).
        const forbidden = /"(monitor|stat|badge|uptime):[^"]*"/;
        const exemptDir = path.join(__dirname, "..", "..", "server", "repository");
        const walk = (dir) => {
            let hits = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    hits = hits.concat(walk(full));
                } else if (entry.name.endsWith(".js")) {
                    hits.push(full);
                }
            }
            return hits;
        };
        const violations = [];
        for (const file of walk(path.join(__dirname, "..", "..", "server"))) {
            if (file.startsWith(exemptDir)) {
                continue; // cache-namespace.js owns the canonical prefix literals
            }
            const lines = fs.readFileSync(file, "utf8").split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (forbidden.test(lines[i]) && !lines[i].includes("// cache key not tenant-scoped")) {
                    violations.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
                }
            }
        }
        assert.deepEqual(violations, [], "hand-written cache-key strings must adopt tenantCacheKey or document a global scope");
    });
});

describe("G4.20 — default-tenant backward compatibility (no over-blocking)", () => {
    test("default-tenant admin reads, edits and pauses their own resources normally", async () => {
        const s = await loginAs("root", TENANT_DEFAULT);

        const got = await emitAck(s.client, "getMonitor", DEFAULT_MONITOR);
        assert.equal(got.ok, true);
        assert.equal(got.monitor.id, DEFAULT_MONITOR);

        const beats = await emitAck(s.client, "getMonitorBeats", DEFAULT_MONITOR, 0);
        assert.equal(beats.ok, true);
        assert.equal(beats.data.length, 1);

        const renamed = await emitAck(s.client, "editMonitor", { id: DEFAULT_MONITOR, name: "default-http-v2" });
        assert.equal(renamed.ok, true);
        const row = await db("monitor").where("id", DEFAULT_MONITOR).first();
        assert.equal(row.name, "default-http-v2");

        const paused = await emitAck(s.client, "pauseMonitor", DEFAULT_MONITOR);
        assert.equal(paused.ok, true);

        s.client.disconnect();
    });

    test("default-tenant admin manages own tag and notification (legacy flows)", async () => {
        const s = await loginAs("root", TENANT_DEFAULT);

        const edited = await emitAck(s.client, "editTag", { id: 999, name: "new-tag", color: "#123456" });
        assert.equal(edited.ok, false, "unknown tag still surfaces tagNotFound semantics, not silent ok");

        const del = await emitAck(s.client, "deleteNotification", 310);
        assert.equal(del.ok, true, "own default-tenant notification deletion works");
        const gone = await db("notification").where("id", 310).first();
        assert.equal(gone, undefined, "row actually deleted in the correct tenant");

        s.client.disconnect();
    });
});
