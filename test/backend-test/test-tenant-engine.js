/**
 * G5.23 — Multi-Tenant Engine Acceptance Suite (KUM-208). Closes Phase G5.
 *
 * Validates the full monitoring-engine pipeline end-to-end across tenants:
 * per-tenant quota enforcement (max monitors / min check interval), the
 * Prometheus tenant_id label, per-plan heartbeat/stat retention, and
 * noisy-neighbor fairness tunables.
 *
 * Harness choices (per the test-tenant-auth.js / test-tenant-idor.js
 * precedent — production server/server.js must not be required from tests:
 * its module graph instantiates UptimeKumaServer and pulls the ESM-only
 * `unlimited-timeout` chain that fails below Node 22):
 *
 * 1. Database: fresh temp SQLite wired into redbean-node via R.setup()
 *    with the minimal multi-tenant schema (pattern of test-repo-tenant.js +
 *    migrations 2026-08-23-000x). Fixtures follow the G1 task-07 demo-seed
 *    structure (tenants default/acme/xyz).
 *
 * 2. Engine surface: the REAL requirable building blocks —
 *    Monitor.enforceStartQuota/getTenantQuota (the exact statics called by
 *    server.js startMonitor), Prometheus (init/update/remove against a real
 *    prom-client registry), clearOldData (the real background job), and the
 *    real Monitor.start()/stop() beat loop emitting live heartbeats through
 *    a REAL socket.io server whose rooms bind exactly like the post-login
 *    joinUserRooms contract (task-11). server/server.js wiring itself is
 *    asserted structurally (source markers), complementing the kanban's own
 *    grep verification commands.
 *
 * Requires Node >= 22 (require(esm) for unlimited-timeout), matching the
 * pinned CI interpreter (ops/durably-pin-node22-interpreter).
 */
/* eslint-disable uptime-kuma/require-tenant-scope -- this harness mirrors production call shapes verbatim; tenant filtering itself is the behavior under test, and registry/global reads follow the documented exemptions */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "development";

const { R } = require("redbean-node");
const { Server } = require("socket.io");
const { io: ClientIO } = require("socket.io-client");
const dayjs = require("dayjs");

const {
    findOneForTenant,
    findForTenant,
} = require("../../server/repository");
// Monitor is loaded lazily in before(): its import graph pulls the ESM-only
// `unlimited-timeout`, requirable only on Node >= 22 (see header note).
let Monitor;
const { Prometheus } = require("../../server/prometheus");
const TranslatableError = require("../../server/translatable-error");
const { clearOldData, getRetentionDaysForPlan } = require("../../server/jobs/clear-old-data");
const { userRoom } = require("../../server/socket-handlers/tenant-room");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const { Settings } = require("../../server/settings");
const { parsePositiveInt } = require("../../src/util");
const Database = require("../../server/database");

/**
 * Node gate: only monitor.js's module graph is Node-22-gated, so on older
 * interpreters the suite registers as skipped instead of crashing at load.
 */
const NODE_MAJOR = parseInt(process.version.slice(1).split(".")[0], 10);
const engineDescribe = NODE_MAJOR >= 22 ? describe : describe.skip;

/** Fixture tenant ids (explicit, demo-seed shaped: default/acme/xyz). */
const TENANT_DEFAULT = 1;
const TENANT_ACME = 2;
const TENANT_XYZ = 3;
// Dedicated quota-scenario tenants so cap/rate tests never share row state.
const TENANT_CAP = 4;
const TENANT_RATE = 5;

let db;
let dbPath;
let ioServer;
let socketHttpServer;
let socketPort;
let targetHttpServer;
let targetPort;

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
 * @param {string} p Path of the temp database file
 * @returns {void}
 */
function removeDbFile(p) {
    for (const suffix of [ "", "-wal", "-shm" ]) {
        if (fs.existsSync(p + suffix)) {
            fs.rmSync(p + suffix);
        }
    }
}

/**
 * Connect one real client and bind its tenant-scoped user room server-side,
 * mirroring the post-login joinUserRooms(task-11) contract: rooms are bound
 * by the server from the authenticated identity, never chosen by clients.
 * @param {number} tenantId Tenant to activate
 * @param {number} userId User to act as
 * @param {(payload: any) => void} onHeartbeat Collector for live heartbeat events
 * @returns {Promise<object>} Connected socket.io-client handle
 */
function connectTenantClient(tenantId, userId, onHeartbeat) {
    return new Promise((resolve, reject) => {
        const client = ClientIO(`http://127.0.0.1:${socketPort}`, {
            transports: [ "websocket" ],
            reconnection: false,
            auth: {
                tenantId,
                userId,
            },
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
        if (onHeartbeat) {
            client.on("heartbeat", (bean) => onHeartbeat(bean));
        }
    });
}

/**
 * Seed one active monitor row and return its bean (loaded through the
 * tenant-scoped wrapper, exactly like production startMonitor loads it).
 * @param {number} tenantId Owning tenant
 * @param {number} userId Owning user
 * @param {string} name Monitor name
 * @param {{interval?: number, active?: number}} opts Overrides
 * @returns {Promise<object>} Loaded monitor bean
 */
async function seedMonitor(tenantId, userId, name, opts = {}) {
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- harness fixture write mirrors dispenseForTenant usage
    let bean = R.dispense("monitor");
    bean.tenant_id = tenantId;
    bean.user_id = userId;
    bean.name = name;
    bean.type = "http";
    bean.url = `http://127.0.0.1:${targetPort}/ok`;
    bean.interval = opts.interval ?? 20;
    bean.active = opts.active ?? 1;
    bean.weight = 1000;
    bean.retry_interval = 60;
    bean.retries = 0;
    bean.maxretries = 2;
    bean.resend_interval = 0;
    bean.timeout = 5000;
    bean.upside_down = 0;
    bean.ignore_tls = 0;
    bean.accepted_statuscodes_json = '["200-299"]';
    await R.store(bean);

    const loaded = await findOneForTenant("monitor", " id = ? ", [bean.id], tenantId);
    assert.ok(loaded, `seeded monitor ${name} should load through the tenant scope`);
    return loaded;
}

/**
 * Seed a heartbeat row with a given age (hours ago).
 * @param {number} monitorId Anchor monitor
 * @param {number} hoursAgo Age of the beat in hours
 * @param {number} status Beat status (1 = UP)
 * @param {number} important Important beats survive the global sweep and are
 * only pruned by the plan-based retention DELETE
 * @returns {Promise<void>}
 */
async function seedHeartbeat(monitorId, hoursAgo, status, important = 1) {
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- heartbeat is FK-anchored to monitor (no tenant_id column by G1 design); anchor was created tenant-scoped
    let bean = R.dispense("heartbeat");
    bean.monitor_id = monitorId;
    bean.status = status;
    bean.msg = "fixture";
    bean.ping = 10;
    bean.important = important;
    bean.down_count = 0;
    bean.retries = 0;
    bean.time = R.isoDateTimeMillis(dayjs.utc().subtract(hoursAgo, "hour"));
    await R.store(bean);
}

/**
 * Seed an aggregate stat row.
 * @param {string} table "stat_minutely" | "stat_hourly" | "stat_daily"
 * @param {number} monitorId Anchor monitor
 * @param {number} timestamp Unix-second bucket timestamp
 * @returns {Promise<void>}
 */
async function seedStat(table, monitorId, timestamp) {
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- stat tables carry no tenant_id column (G1 design); anchored to a tenant-scoped monitor
    let bean = R.dispense(table);
    bean.monitor_id = monitorId;
    bean.timestamp = timestamp;
    bean.ping = 10;
    bean.ping_min = 10;
    bean.ping_max = 10;
    bean.up = 1;
    bean.down = 0;
    await R.store(bean);
}

/**
 * Count heartbeat rows anchored to a monitor.
 * @param {number} monitorId Anchor monitor
 * @returns {Promise<number>} Row count
 */
async function countBeats(monitorId) {
    return await R.getCell("SELECT COUNT(*) FROM heartbeat WHERE monitor_id = ?", [monitorId]);
}

// Tenant-partitioned engine buckets mirrored from server.monitorListByTenant
// (same shape; server.js itself is not requirable from tests).
const engineBuckets = {};

before(async () => {
    // Lazy-load the real Monitor model (Node >= 22 only; see header note).
    Monitor = require("../../server/model/monitor");

    // --- database ---
    dbPath = path.join(os.tmpdir(), `kum-g5-engine-test-${process.pid}-${Date.now()}.sqlite3`);
    removeDbFile(dbPath);
    db = await createTestKnex(dbPath);

    // Production reads Database.dbConfig.type for SQL dialect helpers; the
    // test wires the same shape an initialized sqlite install would have.
    Database.dbConfig = {
        type: "sqlite",
    };

    // Minimal multi-tenant schema (subset of knex_init_db.js + 2026-08-23-0001)
    await db.schema.createTable("tenant", (t) => {
        t.increments("id").primary();
        t.string("name");
        t.string("slug").unique();
        t.string("plan");
        t.string("status");
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
        t.string("method");
        t.text("body");
        t.text("headers");
        t.string("basic_auth_user");
        t.string("basic_auth_pass");
        t.integer("timeout");
        t.integer("interval");
        t.integer("retry_interval");
        t.integer("retries");
        t.integer("maxretries");
        t.integer("resend_interval");
        t.string("hostname");
        t.integer("port");
        t.boolean("active").notNullable().defaultTo(true);
        t.integer("user_id");
        t.integer("tenant_id");
        t.integer("weight").notNullable().defaultTo(1000);
        t.boolean("upside_down").notNullable().defaultTo(false);
        t.integer("maxredirects");
        t.boolean("accept_selfsigned").notNullable().defaultTo(false);
        t.boolean("expiry_notification").notNullable().defaultTo(false);
        t.boolean("ignore_tls").notNullable().defaultTo(false);
        t.text("accepted_statuscodes_json");
        t.integer("parent");
        t.integer("proxy_id");
        t.string("push_token");
    });
    await db.schema.createTable("heartbeat", (t) => {
        t.increments("id").primary();
        t.boolean("important").notNullable().defaultTo(false);
        t.string("msg");
        t.integer("ping");
        t.integer("monitor_id");
        t.string("time");
        t.string("end_time");
        t.integer("status");
        t.integer("down_count").notNullable().defaultTo(0);
        t.integer("retries").notNullable().defaultTo(0);
    });
    for (const statTable of [ "stat_minutely", "stat_hourly", "stat_daily" ]) {
        await db.schema.createTable(statTable, (t) => {
            t.increments("id").primary();
            t.integer("monitor_id");
            t.integer("timestamp");
            t.float("ping");
            t.float("ping_min").defaultTo(0);
            t.float("ping_max").defaultTo(0);
            t.smallint("up").defaultTo(0);
            t.smallint("down").defaultTo(0);
            t.text("extras");
        });
    }
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
    await db.schema.createTable("maintenance", (t) => {
        t.increments("id").primary();
        t.string("title");
        t.text("description");
        t.integer("user_id");
        t.boolean("active").notNullable().defaultTo(true);
        t.string("strategy").notNullable().defaultTo("single");
        t.integer("tenant_id");
    });
    await db.schema.createTable("monitor_maintenance", (t) => {
        t.increments("id").primary();
        t.integer("monitor_id");
        t.integer("maintenance_id");
    });
    await db.schema.createTable("monitor_tls_info", (t) => {
        t.increments("id").primary();
        t.integer("monitor_id");
        t.text("info_json");
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
    await db.schema.createTable("monitor_notification", (t) => {
        t.increments("id").primary();
        t.integer("monitor_id");
        t.integer("notification_id");
    });
    await db.schema.createTable("setting", (t) => {
        t.increments("id").primary();
        t.string("key").notNullable();
        t.text("value");
        t.string("type");
    });

    // --- fixtures (G1 task-07 demo-seed shape) ---
    await db("tenant").insert([
        {
            id: TENANT_DEFAULT,
            name: "Default Tenant",
            slug: "default",
            plan: "free",
            status: "active",
        },
        {
            id: TENANT_ACME,
            name: "Acme",
            slug: "acme",
            plan: "free",
            status: "active",
        },
        {
            id: TENANT_XYZ,
            name: "XYZ",
            slug: "xyz",
            plan: "pro",
            status: "active",
        },
    ]);
    await db("user").insert([
        {
            id: 11,
            username: "default-admin",
            password: "x",
        },
        {
            id: 12,
            username: "acme-admin",
            password: "x",
        },
        {
            id: 13,
            username: "xyz-admin",
            password: "x",
        },
    ]);
    await db("tenant_user").insert([
        {
            user_id: 11,
            tenant_id: TENANT_DEFAULT,
            role: "tenant_admin",
        },
        {
            user_id: 12,
            tenant_id: TENANT_ACME,
            role: "tenant_admin",
        },
        {
            user_id: 13,
            tenant_id: TENANT_XYZ,
            role: "tenant_admin",
        },
    ]);
    await db("tag").insert({
        id: 1,
        name: "alpha",
        color: "#059669",
        tenant_id: TENANT_ACME,
    });

    // Dedicated quota-scenario tenants (free plans, no shared row state).
    await db("tenant").insert([
        {
            id: TENANT_CAP,
            name: "CapCo",
            slug: "capco",
            plan: "free",
            status: "active",
        },
        {
            id: TENANT_RATE,
            name: "RateCo",
            slug: "rateco",
            plan: "free",
            status: "active",
        },
    ]);
    await db("user").insert([
        {
            id: 14,
            username: "capco-admin",
            password: "x",
        },
        {
            id: 15,
            username: "rateco-admin",
            password: "x",
        },
    ]);
    await db("tenant_user").insert([
        {
            user_id: 14,
            tenant_id: TENANT_CAP,
            role: "tenant_admin",
        },
        {
            user_id: 15,
            tenant_id: TENANT_RATE,
            role: "tenant_admin",
        },
    ]);

    // Bind the real model classes to redbean beans (production does this via
    // Database.init autoloadModels) so loaded beans expose Monitor methods.
    await R.autoloadModels(path.join(__dirname, "..", "..", "server", "model"));

    // --- local HTTP check target (offline-safe monitor checks) ---
    targetHttpServer = http.createServer((req, res) => {
        res.writeHead(200, {
            "Content-Type": "text/plain",
        });
        res.end("ok");
    });
    await new Promise((resolve) => {
        targetHttpServer.listen(0, "127.0.0.1", resolve);
    });
    targetPort = targetHttpServer.address().port;

    // --- real Socket.IO server binding task-11 rooms ---
    ioServer = new Server();
    ioServer.on("connection", (socket) => {
        const auth = socket.handshake.auth || {};
        if (auth.tenantId != null && auth.userId != null) {
            socket.join(userRoom(auth.tenantId, auth.userId));
        }
    });
    socketHttpServer = http.createServer();
    ioServer.attach(socketHttpServer);
    await new Promise((resolve) => {
        socketHttpServer.listen(0, "127.0.0.1", resolve);
    });
    socketPort = socketHttpServer.address().port;

    // --- Prometheus metric definitions against the temp tag table ---
    await Prometheus.init();

    engineBuckets[TENANT_ACME] = {};
    engineBuckets[TENANT_XYZ] = {};
});

after(async () => {
    // Stop every started monitor so beat timers do not leak.
    for (const bucket of Object.values(engineBuckets)) {
        for (const id of Object.keys(bucket)) {
            try {
                await bucket[id].stop();
            } catch (_) {
                // best effort teardown
            }
            delete bucket[id];
        }
    }

    await new Promise((resolve) => ioServer.close(resolve));
    await new Promise((resolve) => socketHttpServer.close(resolve));
    await new Promise((resolve) => targetHttpServer.close(resolve));

    // Stop the Settings cache-cleaner interval so the process can exit.
    Settings.stopCacheCleaner();

    await db.destroy();
    removeDbFile(dbPath);
});

engineDescribe("G5.23 — per-tenant quota enforcement (Monitor.enforceStartQuota)", () => {

    test("free-plan tenant at the cap throws TranslatableError('quotaExceeded')", async () => {
        const target = await seedMonitor(TENANT_CAP, 14, "capco-probe", {
            active: 0,
        });

        // Free plan caps at 100 ACTIVE monitors; seed 100 others.
        for (let i = 0; i < 100; i++) {
            await seedMonitor(TENANT_CAP, 14, `capco-bulk-${i}`, {
                active: 1,
                interval: 60,
            });
        }

        await assert.rejects(
            () => Monitor.enforceStartQuota(TENANT_CAP, target.id, target.interval),
            (err) => {
                assert.ok(err instanceof TranslatableError, "must be a TranslatableError");
                assert.strictEqual(err.message, "quotaExceeded");
                assert.strictEqual(err.msgi18n, true);
                return true;
            }
        );
    });

    test("restart-at-cap passes: the starting monitor is excluded from the count", async () => {
        const active = await findForTenant("monitor", "active = 1", [], TENANT_CAP);
        assert.ok(active.length >= 100, "fixture precondition: at cap");

        // Restarting monitor #1 (already active): others = 99 active < 100.
        await Monitor.enforceStartQuota(TENANT_CAP, active[0].id, active[0].interval);
    });

    test("free-plan tenant below the cap passes", async () => {
        const other = await seedMonitor(TENANT_RATE, 15, "rateco-existing", {
            active: 1,
            interval: 60,
        });
        const target = await seedMonitor(TENANT_RATE, 15, "rateco-under-cap", {
            active: 0,
            interval: 60,
        });
        assert.strictEqual(other.active, 1);
        await Monitor.enforceStartQuota(TENANT_RATE, target.id, target.interval);
    });

    test("free-plan minimum interval rejects below-minimum checks with 'intervalTooLow'", async () => {
        await assert.rejects(
            () => Monitor.enforceStartQuota(TENANT_RATE, 999999998, 30),
            (err) => {
                assert.ok(err instanceof TranslatableError);
                assert.strictEqual(err.message, "intervalTooLow");
                return true;
            }
        );
    });

    test("boundary: interval equal to the plan minimum passes", async () => {
        await Monitor.enforceStartQuota(TENANT_RATE, 999999997, 60);
    });

    test("pro plan allows higher rate (min 30s) and larger cap (500)", async () => {
        const quota = await Monitor.getTenantQuota(TENANT_XYZ);
        assert.deepStrictEqual(quota, {
            plan: "pro",
            maxMonitors: 500,
            minCheckInterval: 30,
        });

        const probe = await seedMonitor(TENANT_XYZ, 13, "xyz-rate-probe", {
            active: 0,
            interval: 30,
        });
        await Monitor.enforceStartQuota(TENANT_XYZ, probe.id, 30);

        await assert.rejects(
            () => Monitor.enforceStartQuota(TENANT_XYZ, probe.id, 20),
            (err) => err.message === "intervalTooLow"
        );
    });

    test("unknown/null plan falls back to free defaults; missing tenant too", async () => {
        await db("tenant").where("id", TENANT_XYZ).update({
            plan: "galactic",
        });
        const unknownPlan = await Monitor.getTenantQuota(TENANT_XYZ);
        assert.strictEqual(unknownPlan.maxMonitors, 100);
        assert.strictEqual(unknownPlan.minCheckInterval, 60);
        await db("tenant").where("id", TENANT_XYZ).update({
            plan: "pro",
        });

        const missing = await Monitor.getTenantQuota(424242);
        assert.strictEqual(missing.plan, "free");
        assert.strictEqual(missing.maxMonitors, 100);
    });

    test("default tenant stays unlimited (legacy single-tenant parity)", async () => {
        const quota = await Monitor.getTenantQuota(TENANT_DEFAULT);
        assert.strictEqual(quota.maxMonitors, null);
        assert.strictEqual(quota.minCheckInterval, null);

        // Even a sub-free-minimum interval must pass for the default tenant.
        await Monitor.enforceStartQuota(TENANT_DEFAULT, 999999999, 5);
    });
});

engineDescribe("G5.23 — per-plan retention (clearOldData)", () => {

    test("getRetentionDaysForPlan maps plans and defaults unknowns", () => {
        assert.strictEqual(getRetentionDaysForPlan("free"), 7);
        assert.strictEqual(getRetentionDaysForPlan("pro"), 90);
        assert.strictEqual(getRetentionDaysForPlan("business"), 365);
        assert.strictEqual(getRetentionDaysForPlan("enterprise"), 730);
        assert.strictEqual(getRetentionDaysForPlan(null), 365);
        assert.strictEqual(getRetentionDaysForPlan("wat"), 365);
    });

    test("prunes each tenant by its own plan window (heartbeat + stat tables)", async () => {
        const acmeOld = await seedMonitor(TENANT_ACME, 12, "acme-retention-a", {
            active: 0,
        });
        const xyzKeep = await seedMonitor(TENANT_XYZ, 13, "xyz-retention-keep", {
            active: 0,
        });
        const xyzAncient = await seedMonitor(TENANT_XYZ, 13, "xyz-retention-old", {
            active: 0,
        });

        // Acme (free=7d): 14-day-old beat must go, 1-hour-old beat stays.
        await seedHeartbeat(acmeOld.id, 14 * 24);
        await seedHeartbeat(acmeOld.id, 1);

        // XYZ (pro=90d): 30-day-old beat survives, 400-day-old beat goes.
        await seedHeartbeat(xyzKeep.id, 30 * 24);
        await seedHeartbeat(xyzAncient.id, 400 * 24);

        // Stat rows: acme daily 14d old (goes); xyz daily 30d old (stays),
        // xyz hourly/minutely 400d old (go).
        await seedStat("stat_daily", acmeOld.id, dayjs.utc().subtract(14, "day").startOf("day").unix());
        await seedStat("stat_daily", xyzKeep.id, dayjs.utc().subtract(30, "day").startOf("day").unix());
        await seedStat("stat_daily", xyzAncient.id, dayjs.utc().subtract(400, "day").startOf("day").unix());
        await seedStat("stat_hourly", xyzAncient.id, dayjs.utc().subtract(400, "day").unix());
        await seedStat("stat_minutely", xyzAncient.id, dayjs.utc().subtract(400, "day").unix());

        await clearOldData();

        assert.strictEqual(await countBeats(acmeOld.id), 1, "acme: recent beat survives the free window");
        assert.strictEqual(await countBeats(xyzKeep.id), 1, "xyz: 30d beat survives the pro window");

        const acmeDaily = await R.getCell("SELECT COUNT(*) FROM stat_daily WHERE monitor_id = ?", [acmeOld.id]);
        assert.strictEqual(acmeDaily, 0, "acme: 14d daily stat pruned by free window");
        const xyzDaily = await R.getCell("SELECT COUNT(*) FROM stat_daily WHERE monitor_id = ?", [xyzKeep.id]);
        assert.strictEqual(xyzDaily, 1, "xyz: 30d daily stat survives pro window");
        const xyzHourly = await R.getCell("SELECT COUNT(*) FROM stat_hourly WHERE monitor_id = ?", [xyzAncient.id]);
        assert.strictEqual(xyzHourly, 0, "xyz: ancient hourly stat pruned");
        const xyzMinutely = await R.getCell("SELECT COUNT(*) FROM stat_minutely WHERE monitor_id = ?", [xyzAncient.id]);
        assert.strictEqual(xyzMinutely, 0, "xyz: ancient minutely stat pruned");
    });

    test("default tenant keeps the legacy Settings-driven period, not the free-plan window", async () => {
        const defMon = await seedMonitor(TENANT_DEFAULT, 11, "default-retention", {
            active: 0,
        });

        // 90 days old: inside the legacy 365d default, far outside free=7d.
        await seedHeartbeat(defMon.id, 90 * 24);
        await clearOldData();
        assert.strictEqual(
            await countBeats(defMon.id),
            1,
            "legacy period (365d default) must apply to the default tenant"
        );

        // Shrink the legacy period: now the same-age beat is pruned.
        await setKeepDataPeriodDays(1);
        await clearOldData();
        assert.strictEqual(await countBeats(defMon.id), 0, "legacy period change still governs the default tenant");
        await setKeepDataPeriodDays(null);
    });

    test("with zero tenant rows, falls back to the original global behavior", async () => {
        const orphans = await findForTenant("monitor", "active = 1 AND id IS NOT NULL", [], TENANT_ACME);
        const probe = await seedMonitor(TENANT_ACME, 12, "legacy-fallback-probe", {
            active: 0,
        });
        await seedHeartbeat(probe.id, 3 * 24);

        const tenantCountBefore = (await R.findAll("tenant")).length;
        assert.ok(tenantCountBefore > 0, "precondition");

        await setKeepDataPeriodDays(1);
        await db("tenant").del(); // simulate a pre-G1 legacy install
        await clearOldData();

        assert.strictEqual(await countBeats(probe.id), 0, "global settings period applies without tenants");
        assert.ok(orphans.length >= 0);

        // Restore the multi-tenant world for any later assertions.
        await db("tenant").insert([
            {
                id: TENANT_DEFAULT,
                name: "Default Tenant",
                slug: "default",
                plan: "free",
                status: "active",
            },
            {
                id: TENANT_ACME,
                name: "Acme",
                slug: "acme",
                plan: "free",
                status: "active",
            },
            {
                id: TENANT_XYZ,
                name: "XYZ",
                slug: "xyz",
                plan: "pro",
                status: "active",
            },
        ]);
        await setKeepDataPeriodDays(null);
    });
});

engineDescribe("G5.23 — Prometheus tenant_id labeling", () => {

    /**
     * Extract the series lines of a metric family from the registry output.
     * @param {string} metricsText Full registry exposition text
     * @param {string} name Metric name
     * @returns {string[]} Matching series lines
     */
    function seriesOf(metricsText, name) {
        return metricsText.split("\n").filter((line) => line.startsWith(name + "{") || line.startsWith(name + " "));
    }

    test("all six gauges expose a leading tenant_id label; names unchanged", async () => {
        const text = await require("prom-client").register.metrics();
        for (const name of [
            "monitor_status",
            "monitor_response_time",
            "monitor_response_time_seconds",
            "monitor_uptime_ratio",
            "monitor_cert_days_remaining",
            "monitor_cert_is_valid",
        ]) {
            assert.ok(text.includes(name), `${name} still exported`);
        }

        const p = new Prometheus({
            id: 900001,
            tenant_id: TENANT_ACME,
            name: "label-shape-probe",
            type: "http",
            url: "",
            hostname: null,
            port: null,
        }, []);
        p.update(TENANT_ACME, {
            status: 1,
            ping: 5,
        }, undefined, null);
        const after = await require("prom-client").register.metrics();
        const statusLine = after.split("\n").find((l) => l.startsWith("monitor_status{"));
        assert.ok(statusLine.includes('tenant_id="2"'), `monitor_status carries tenant_id label: ${statusLine}`);
        assert.ok(
            statusLine.indexOf('tenant_id="') < statusLine.indexOf('monitor_id="'),
            "tenant_id leads the label set"
        );
        p.remove(TENANT_ACME, 900001);
    });

    test("same monitor labels in different tenants export distinct tenant_id series", async () => {
        const acmeP = new Prometheus({
            id: 900002,
            tenant_id: TENANT_ACME,
            name: "shared-name",
            type: "http",
            url: "",
            hostname: null,
            port: null,
        }, []);
        const xyzP = new Prometheus({
            id: 900002,
            tenant_id: TENANT_XYZ,
            name: "shared-name",
            type: "http",
            url: "",
            hostname: null,
            port: null,
        }, []);

        acmeP.update(TENANT_ACME, {
            status: 1,
            ping: 10,
        }, undefined, null);
        xyzP.update(TENANT_XYZ, {
            status: 0,
            ping: 99,
        }, undefined, null);

        const text = await require("prom-client").register.metrics();
        const lines = seriesOf(text, "monitor_status").filter((l) => l.includes('monitor_id="900002"'));
        assert.strictEqual(lines.length, 2, "two series for the same monitor_id, one per tenant");
        assert.ok(lines.some((l) => l.includes('tenant_id="2"')));
        assert.ok(lines.some((l) => l.includes('tenant_id="3"')));

        // remove(tenantId, monitorID) drops exactly its own tenant's series.
        acmeP.remove(TENANT_ACME, 900002);
        const afterRemove = await require("prom-client").register.metrics();
        const remaining = seriesOf(afterRemove, "monitor_status").filter((l) => l.includes('monitor_id="900002"'));
        assert.strictEqual(remaining.length, 1);
        assert.ok(remaining[0].includes('tenant_id="3"'));
        xyzP.remove(TENANT_XYZ, 900002);
    });

    test("null tenantId falls back to the constructor value; null-tenant exports empty label", async () => {
        const p = new Prometheus({
            id: 900003,
            tenant_id: TENANT_XYZ,
            name: "fallback-probe",
            type: "http",
            url: "",
            hostname: null,
            port: null,
        }, []);
        p.update(null, {
            status: 1,
            ping: 1,
        }, undefined, null);
        let text = await require("prom-client").register.metrics();
        let line = text.split("\n").find((l) => l.startsWith("monitor_status{") && l.includes('monitor_id="900003"'));
        assert.ok(line.includes('tenant_id="3"'), "null argument keeps constructor tenant");

        const legacy = new Prometheus({
            id: 900004,
            tenant_id: null,
            name: "legacy-null-tenant",
            type: "http",
            url: "",
            hostname: null,
            port: null,
        }, []);
        legacy.update(null, {
            status: 1,
            ping: 1,
        }, undefined, null);
        text = await require("prom-client").register.metrics();
        line = text.split("\n").find((l) => l.startsWith("monitor_status{") && l.includes('monitor_id="900004"'));
        assert.ok(line.includes('tenant_id=""'), "null-tenant row exports empty tenant_id label");
        legacy.remove(null, 900004);
        p.remove(null, 900003);
    });
});

engineDescribe("G5.23 — engine lifecycle & cross-tenant isolation (real beat loop)", () => {

    /** Collected live heartbeat events per tenant client. */
    const received = {
        acme: [],
        xyz: [],
    };
    let acmeClient;
    let xyzClient;

    before(async () => {
        acmeClient = await connectTenantClient(TENANT_ACME, 12, (b) => received.acme.push(b));
        xyzClient = await connectTenantClient(TENANT_XYZ, 13, (b) => received.xyz.push(b));
    });

    after(async () => {
        if (acmeClient) {
            acmeClient.disconnect();
        }
        if (xyzClient) {
            xyzClient.disconnect();
        }
    });

    /**
     * Wait until a condition becomes true, polling.
     * @param {() => boolean} cond Condition
     * @param {number} timeoutMs Timeout
     * @param {string} what Description for the failure message
     * @returns {Promise<void>}
     */
    async function waitFor(cond, timeoutMs, what) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (cond()) {
                return;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`timeout waiting for ${what}`);
    }

    /**
     * Mirror of server.js startMonitor()'s engine half (post-quota-gate):
     * register into the tenant-partitioned bucket and start the beat loop.
     * @param {number} tenantId Tenant bucket
     * @param {object} monitor Loaded monitor bean
     * @returns {Promise<void>}
     */
    async function engineStartMonitor(tenantId, monitor) {
        if (!engineBuckets[tenantId]) {
            engineBuckets[tenantId] = {};
        }
        const bucket = engineBuckets[tenantId];
        if (monitor.id in bucket) {
            await bucket[monitor.id].stop();
        }
        bucket[monitor.id] = monitor;
        await monitor.start(ioServer);
    }

    test("monitor lifecycle: start -> live heartbeat -> pause -> resume -> delete", async () => {
        // Add
        const monitor = await seedMonitor(TENANT_ACME, 12, "acme-lifecycle", {
            active: 0,
            interval: 20,
        });
        await execActiveFlip(monitor.id, 1);
        await engineStartMonitor(TENANT_ACME, monitor);

        assert.ok(engineBuckets[TENANT_ACME][monitor.id], "started monitor registered in tenant bucket");

        // Wait for the first live beat on the owner's tenant room
        await waitFor(
            () => received.acme.some((b) => Number(b.monitorID) === Number(monitor.id)),
            8000,
            "first acme heartbeat"
        );
        const firstBeat = received.acme.find((b) => Number(b.monitorID) === Number(monitor.id));
        assert.ok([ 1, 0, 2, 3 ].includes(firstBeat.status), "beat payload has a valid status");

        // Pause
        await execActiveFlip(monitor.id, 0);
        await engineBuckets[TENANT_ACME][monitor.id].stop();
        assert.strictEqual(engineBuckets[TENANT_ACME][monitor.id].isStop, true);
        assert.strictEqual(
            UptimeCalculator.listByTenant[TENANT_ACME]?.[monitor.id],
            undefined,
            "stop() evicts the tenant-partitioned calculator entry (G5.21 contract)"
        );
        const pausedRow = await R.getRow("SELECT active FROM monitor WHERE id = ?", [monitor.id]);
        assert.strictEqual(Number(pausedRow.active), 0, "pause flips active=0");

        const beatsAtPause = received.acme.filter((b) => Number(b.monitorID) === Number(monitor.id)).length;

        // Resume (fresh bean like production restartMonitor reloads it)
        const resumedBean = await findOneForTenant("monitor", " id = ? ", [monitor.id], TENANT_ACME);
        await execActiveFlip(monitor.id, 1);
        await engineStartMonitor(TENANT_ACME, resumedBean);
        await waitFor(
            () => received.acme.filter((b) => Number(b.monitorID) === Number(monitor.id)).length > beatsAtPause,
            8000,
            "resumed heartbeat"
        );

        // Delete: evict from the tenant bucket then trash (deleteMonitor order)
        await engineBuckets[TENANT_ACME][monitor.id].stop();
        delete engineBuckets[TENANT_ACME][monitor.id];
        await R.trash(resumedBean);
        assert.strictEqual(engineBuckets[TENANT_ACME][monitor.id], undefined, "deleted monitor evicted from bucket");
    });

    test("cross-tenant heartbeat isolation: tenant B never sees tenant A's beats", async () => {
        const monitor = await seedMonitor(TENANT_ACME, 12, "acme-isolation", {
            active: 0,
        });
        await engineStartMonitor(TENANT_ACME, monitor);

        await waitFor(
            () => received.acme.some((b) => Number(b.monitorID) === Number(monitor.id)),
            8000,
            "acme isolation heartbeat"
        );
        // Grace window so a leak would have had time to arrive.
        await new Promise((r) => setTimeout(r, 700));

        assert.ok(received.acme.some((b) => Number(b.monitorID) === Number(monitor.id)), "owner receives beats");
        assert.strictEqual(
            received.xyz.filter((b) => Number(b.monitorID) === Number(monitor.id)).length,
            0,
            "other tenant must not receive the beat"
        );

        await engineBuckets[TENANT_ACME][monitor.id].stop();
        delete engineBuckets[TENANT_ACME][monitor.id];
        await R.trash(monitor);
    });

    test("shutdown/restart: stopping every tenant's engine and re-running staggered startup resumes beats", async () => {
        // Seed one live monitor per tenant so both clients can observe resumption.
        const acmeMon = await seedMonitor(TENANT_ACME, 12, "acme-restart", {
            active: 0,
            interval: 20,
        });
        const xyzMon = await seedMonitor(TENANT_XYZ, 13, "xyz-restart", {
            active: 0,
            interval: 20,
        });
        await execActiveFlip(acmeMon.id, 1);
        await execActiveFlip(xyzMon.id, 1);
        await engineStartMonitor(TENANT_ACME, acmeMon);
        await engineStartMonitor(TENANT_XYZ, xyzMon);
        await waitFor(() => received.acme.some((b) => Number(b.monitorID) === Number(acmeMon.id)), 8000, "acme pre-shutdown beat");
        await waitFor(() => received.xyz.some((b) => Number(b.monitorID) === Number(xyzMon.id)), 8000, "xyz pre-shutdown beat");

        // --- shutdown half (mirrors shutdownFunction's engine sweep): stop
        // every started monitor across all tenant buckets.
        const beatsBeforeAcme = received.acme.filter((b) => Number(b.monitorID) === Number(acmeMon.id)).length;
        const beatsBeforeXyz = received.xyz.filter((b) => Number(b.monitorID) === Number(xyzMon.id)).length;
        for (const bucket of Object.values(engineBuckets)) {
            for (const id of Object.keys(bucket)) {
                try {
                    await bucket[id].stop();
                } catch (_) {
                    // best effort — shutdown must be resilient per monitor
                }
                delete bucket[id];
            }
        }
        assert.strictEqual(Object.keys(engineBuckets[TENANT_ACME]).length, 0, "acme bucket drained");
        assert.strictEqual(Object.keys(engineBuckets[TENANT_XYZ]).length, 0, "xyz bucket drained");

        // --- restart half (mirrors startMonitors' staggered batches):
        // bounded concurrent tenant batches with an inter-batch pause.
        const MAX_CONCURRENT_TENANTS = parsePositiveInt(undefined, 2);
        const tenantIds = [ TENANT_ACME, TENANT_XYZ ];
        for (let i = 0; i < tenantIds.length; i += MAX_CONCURRENT_TENANTS) {
            const batch = tenantIds.slice(i, i + MAX_CONCURRENT_TENANTS);
            await Promise.all(batch.map(async (tenantId) => {
                const monitors = await findForTenant("monitor", " active = 1 ", [], tenantId, "ORDER BY weight DESC");
                for (const monitor of monitors) {
                    if (!engineBuckets[tenantId]) {
                        engineBuckets[tenantId] = {};
                    }
                    engineBuckets[tenantId][monitor.id] = monitor;
                    await monitor.start(ioServer);
                }
            }));
            if (i + MAX_CONCURRENT_TENANTS < tenantIds.length) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }

        // Both tenants' monitors resume emitting into their own rooms.
        await waitFor(
            () => received.acme.filter((b) => Number(b.monitorID) === Number(acmeMon.id)).length > beatsBeforeAcme,
            8000,
            "acme post-restart beat"
        );
        await waitFor(
            () => received.xyz.filter((b) => Number(b.monitorID) === Number(xyzMon.id)).length > beatsBeforeXyz,
            8000,
            "xyz post-restart beat"
        );

        // Teardown this test's monitors so later suites see no live timers.
        for (const [ tenantId, mon ] of [[ TENANT_ACME, acmeMon ], [ TENANT_XYZ, xyzMon ]]) {
            if (engineBuckets[tenantId]?.[mon.id]) {
                await engineBuckets[tenantId][mon.id].stop();
                delete engineBuckets[tenantId][mon.id];
            }
            const bean = await findOneForTenant("monitor", " id = ? ", [mon.id], tenantId);
            await R.trash(bean);
        }
    });
});

engineDescribe("G5.23 — cross-tenant notification isolation", () => {

    test("getNotificationList scopes notifications to the monitor's tenant", async () => {
        // Tenant A (acme) creates a notification and attaches it to a monitor.
        let notifBean = R.dispense("notification");
        notifBean.name = "acme-webhook";
        notifBean.active = 1;
        notifBean.user_id = 12;
        notifBean.is_default = 0;
        notifBean.config = JSON.stringify({
            type: "webhook",
            url: "http://127.0.0.1:9/noop",
        });
        notifBean.tenant_id = TENANT_ACME;
        await R.store(notifBean);

        const monitor = await seedMonitor(TENANT_ACME, 12, "acme-notif-target", {
            active: 0,
        });
        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- join-table write FK-anchored to tenant-scoped fixtures created above
        let linkBean = R.dispense("monitor_notification");
        linkBean.monitor_id = monitor.id;
        linkBean.notification_id = notifBean.id;
        await R.store(linkBean);

        // Owner's tenant sees exactly its own notification on the monitor...
        const acmeList = await Monitor.getNotificationList(monitor, TENANT_ACME);
        assert.strictEqual(acmeList.length, 1, "owner tenant lists its notification");
        assert.strictEqual(Number(acmeList[0].id), Number(notifBean.id));
        assert.strictEqual(Number(acmeList[0].tenant_id), TENANT_ACME);

        // ...tenant B querying the SAME monitor id gets nothing (fail closed)...
        const xyzList = await Monitor.getNotificationList(monitor, TENANT_XYZ);
        assert.strictEqual(xyzList.length, 0, "other tenant cannot see tenant A's notification");

        // ...and the default tenant (legacy admin) is equally scoped out.
        const defaultList = await Monitor.getNotificationList(monitor, TENANT_DEFAULT);
        assert.strictEqual(defaultList.length, 0, "default tenant cannot see tenant A's notification");

        // The production beat path resolves the list from the bean's own
        // tenant (sendCertInfo/sendDomainInfo pass monitor.tenant_id),
        // never the caller's — dispatch stays inside tenant A.
        const beatPathList = await Monitor.getNotificationList(monitor, monitor.tenant_id);
        assert.strictEqual(beatPathList.length, 1, "bean-resolved tenant keeps its dispatch target");

        // Legacy in-process callers that omit tenantId fall back to the
        // default tenant and are scoped out of tenant A's notifications.
        const legacyList = await Monitor.getNotificationList(monitor, null);
        assert.strictEqual(legacyList.length, 0, "null-tenant legacy path resolves to the default tenant's view");

        await R.trash(linkBean);
        await R.trash(notifBean);
    });
});

engineDescribe("G5.23 — fairness tunables & server wiring", () => {

    test("parsePositiveInt: defaults, coercion, and invalid fallbacks", () => {
        assert.strictEqual(parsePositiveInt(undefined, 5), 5);
        assert.strictEqual(parsePositiveInt(null, 5), 5);
        assert.strictEqual(parsePositiveInt("", 5), 5);
        assert.strictEqual(parsePositiveInt("abc", 5), 5);
        assert.strictEqual(parsePositiveInt("-3", 5), 5);
        assert.strictEqual(parsePositiveInt("0", 5), 5);
        assert.strictEqual(parsePositiveInt("12.9", 5), 12);
        assert.strictEqual(parsePositiveInt("8", 5), 8);
        assert.strictEqual(parsePositiveInt("2", 5, 4), 5, "below min falls back");
        assert.strictEqual(parsePositiveInt("9", 5, 4), 9, "at min passes");
    });

    test("server.js wires the quota gate before activation and batches tenant startup", async () => {
        const src = fs.readFileSync(path.join(__dirname, "..", "..", "server", "server.js"), "utf8");

        // Quota gate present inside startMonitor...
        const fnStart = src.indexOf("async function startMonitor(");
        const fnEnd = src.indexOf("async function restartMonitor(");
        assert.ok(fnStart !== -1 && fnEnd > fnStart, "startMonitor located");
        const startMonitorSrc = src.slice(fnStart, fnEnd);
        assert.ok(startMonitorSrc.includes("enforceStartQuota"), "startMonitor calls the quota gate");

        // ...and BEFORE the active=1 flip (a rejected start never activates).
        const gateIdx = startMonitorSrc.indexOf("enforceStartQuota");
        const flipIdx = startMonitorSrc.indexOf("SET active = 1");
        assert.ok(gateIdx !== -1 && flipIdx !== -1 && gateIdx < flipIdx, "gate precedes activation");

        // Staggered startup: bounded concurrent batches + inter-batch pause.
        assert.ok(src.includes("MAX_CONCURRENT_TENANTS"), "batch size constant present");
        assert.ok(
            src.includes("UPTIME_KUMA_MAX_CONCURRENT_TENANT_STARTUP"),
            "env var name present"
        );
        const smStart = src.indexOf("async function startMonitors(");
        const smEnd = src.indexOf("async function shutdownFunction(");
        const startMonitorsSrc = src.slice(smStart, smEnd);
        assert.ok(startMonitorsSrc.includes("Promise.all"), "batched concurrent tenant startup");
        assert.ok(/i \+= MAX_CONCURRENT_TENANTS/.test(startMonitorsSrc), "batch stepping");

        // Retention reads tenant.plan through the monitor anchor.
        const jobsSrc = fs.readFileSync(
            path.join(__dirname, "..", "..", "server", "jobs", "clear-old-data.js"),
            "utf8"
        );
        assert.ok(jobsSrc.includes("RETENTION_DAYS_BY_PLAN"), "plan->retention table present");
        assert.ok(jobsSrc.includes("tenant.plan"), "retention reads tenant.plan");
        assert.ok(jobsSrc.includes("WHERE tenant_id = ?"), "stat pruning scoped through the monitor anchor");
    });
});

/**
 * Flip a monitor's active flag directly (fixture helper).
 * @param {number} monitorId Target monitor
 * @param {number} active 1 or 0
 * @returns {Promise<void>}
 */
async function execActiveFlip(monitorId, active) {
    await R.exec("UPDATE monitor SET active = ? WHERE id = ?", [active, monitorId]);
}

/**
 * Write/clear the legacy keepDataPeriodDays setting.
 *
 * Uses the real Settings.set (writes through its in-memory cache) and
 * Settings.deleteCache on clear — direct row writes would leave a stale
 * cached value behind and the job would read the old period.
 * @param {number|null} days Days value (null clears the setting)
 * @returns {Promise<void>}
 */
async function setKeepDataPeriodDays(days) {
    if (days === null) {
        await R.exec("DELETE FROM setting WHERE `key` = ?", [ "keepDataPeriodDays" ]);
        Settings.deleteCache([ "keepDataPeriodDays" ]);
        return;
    }
    await Settings.set("keepDataPeriodDays", days, "general");
}

