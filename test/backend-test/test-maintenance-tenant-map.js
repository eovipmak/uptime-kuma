/**
 * KUM-188 (G4.21) — tenant-scoped maintenance map regression tests
 *
 * The maintenance socket handlers used to resolve get/pause/edit through the
 * legacy flat `maintenanceList` map, which is keyed by id alone. A user who is
 * a member of two tenants could therefore pause/edit their OWN row living in
 * the OTHER tenant (user_id matches, tenant filter missing) — flagged by the
 * G4.20 cross-tenant IDOR suite.
 *
 * Against a fresh SQLite database carrying the full real migration chain,
 * these tests prove:
 *  1. loadMaintenanceList partitions beans into maintenanceListByTenant so
 *     each tenant only sees its own rows,
 *  2. getMaintenanceForTenant(id, tenantID) returns the bean for the owning
 *     tenant and null for any other tenant (fail closed),
 *  3. addMaintenance-style dual registration keeps both maps consistent,
 *  4. the legacy flat getMaintenance still resolves globally — engine
 *     consumers (model/monitor.js, model/status_page.js) rely on it until G5.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { UptimeKumaServer } = require("../../server/uptime-kuma-server");

const MIGRATION_DIRECTORY = path.join(__dirname, "../../db/knex_migrations");

/**
 * Create a fresh knex instance backed by a temp SQLite file, wired into
 * redbean-node the same way production does (pattern of
 * test-monitor-json-list-tenant-filter.js).
 * @param {string} testDbPath Path of the temp SQLite database file
 * @returns {Promise<object>} knex instance (already R.setup()-wired)
 */
async function createTestKnex(testDbPath) {
    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");

    const knex = require("knex");
    const db = knex({
        client: Dialect,
        connection: {
            filename: testDbPath,
        },
        useNullAsDefault: true,
    });

    const { R } = require("redbean-node");
    R.setup(db);

    // Register server/model/* BeanModels (Maintenance extends BeanModel), the
    // same thing Database.connect() does via autoloadModels in production.
    await R.autoloadModels(path.join(__dirname, "../../server/model"));

    return db;
}

/**
 * Remove a temp database file (+ SQLite sidecar files) if present.
 * @param {string} testDbPath Path of the temp SQLite database file
 * @returns {void}
 */
function removeTestDbFile(testDbPath) {
    for (const suffix of [ "", "-wal", "-shm" ]) {
        const filePath = testDbPath + suffix;
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath);
        }
    }
}

describe("tenant-scoped maintenance map", () => {

    /** @type {object} knex instance shared by the tests in this file */
    let db;
    const testDbPath = path.join(__dirname, "../../data", "test-maintenance-tenant-map.db");

    const TENANT_B_ID = 202; // secondary "acme" tenant inserted below
    const USER_1 = 11;       // member of BOTH tenants (the leak scenario)

    let defaultTenantID;
    let defaultMaintID;
    let acmeMaintID;

    test("setup: base schema + full migration chain + seed multi-tenant data", async () => {
        removeTestDbFile(testDbPath);
        const testDbDir = path.dirname(testDbPath);
        if (!fs.existsSync(testDbDir)) {
            fs.mkdirSync(testDbDir, { recursive: true });
        }
        db = await createTestKnex(testDbPath);

        const { createTables } = require("../../db/knex_init_db.js");
        await createTables();

        await db("user").insert({
            username: "admin",
            password: "$2a$10$placeholderhashplaceholderhash00",
            active: 1,
        });

        await db.migrate.latest({ directory: MIGRATION_DIRECTORY });

        const defaultTenant = await db("tenant").where("slug", "default").first();
        assert.ok(defaultTenant, "default tenant should exist after migrations");
        defaultTenantID = defaultTenant.id;

        await db("tenant").insert({ name: "Acme", slug: "acme" });
        await db("tenant_user").insert([
            { tenant_id: defaultTenantID, user_id: USER_1, role: "tenant_admin" },
            { tenant_id: TENANT_B_ID, user_id: USER_1, role: "tenant_admin" },
        ]);

        // strategy "manual" keeps loadMaintenanceList()'s fire-and-forget
        // maintenance.run() from creating Croner jobs (no stray timers).
        await db("maintenance").insert({
            title: "default-maint",
            description: "",
            user_id: USER_1,
            active: true,
            strategy: "manual",
            tenant_id: defaultTenantID,
        });
        await db("maintenance").insert({
            title: "acme-maint",
            description: "",
            user_id: USER_1,
            active: true,
            strategy: "manual",
            tenant_id: TENANT_B_ID,
        });

        // node-sqlite3 has no INSERT ... RETURNING; read the ids back instead
        defaultMaintID = (await db("maintenance").where({ title: "default-maint" }).first()).id;
        acmeMaintID = (await db("maintenance").where({ title: "acme-maint" }).first()).id;

        assert.ok(defaultMaintID && acmeMaintID, "both maintenance rows inserted");
    });

    test("loadMaintenanceList partitions beans into per-tenant maps", async () => {
        const server = UptimeKumaServer.getInstance();
        await server.loadMaintenanceList();

        const defaultMap = server.maintenanceListByTenant[defaultTenantID] || {};
        const acmeMap = server.maintenanceListByTenant[TENANT_B_ID] || {};

        assert.ok(defaultMap[defaultMaintID], "default tenant map holds its row");
        assert.ok(acmeMap[acmeMaintID], "acme tenant map holds its row");
        assert.strictEqual(defaultMap[acmeMaintID], undefined, "default tenant map must NOT hold acme's row");
        assert.strictEqual(acmeMap[defaultMaintID], undefined, "acme tenant map must NOT hold default's row");
    });

    test("getMaintenanceForTenant fails closed across tenants", () => {
        const server = UptimeKumaServer.getInstance();

        // Own-tenant hit returns the live bean
        assert.strictEqual(
            server.getMaintenanceForTenant(defaultMaintID, defaultTenantID).id,
            defaultMaintID
        );

        // The IDOR fix: same user, wrong active tenant → miss, not the row
        assert.strictEqual(server.getMaintenanceForTenant(defaultMaintID, TENANT_B_ID), null);
        assert.strictEqual(server.getMaintenanceForTenant(acmeMaintID, defaultTenantID), null);

        // Unknown/absent tenant → miss
        assert.strictEqual(server.getMaintenanceForTenant(defaultMaintID, 999999), null);
    });

    test("dual registration mirrors what addMaintenance does at runtime", () => {
        const server = UptimeKumaServer.getInstance();

        // Simulate the addMaintenance handler's dual-map bookkeeping
        const newID = 987001;
        const fakeBean = { id: newID, title: "runtime-added" };
        server.maintenanceList[newID] = fakeBean;
        if (!server.maintenanceListByTenant[TENANT_B_ID]) {
            server.maintenanceListByTenant[TENANT_B_ID] = {};
        }
        server.maintenanceListByTenant[TENANT_B_ID][newID] = fakeBean;

        try {
            assert.strictEqual(server.getMaintenanceForTenant(newID, TENANT_B_ID), fakeBean);
            assert.strictEqual(server.getMaintenanceForTenant(newID, defaultTenantID), null);
        } finally {
            delete server.maintenanceList[newID];
            delete server.maintenanceListByTenant[TENANT_B_ID][newID];
        }
    });

    test("legacy flat getMaintenance stays global for engine consumers", () => {
        const server = UptimeKumaServer.getInstance();

        // model/monitor.js + model/status_page.js read through the flat map
        // until G5 replaces engine dispatch — it must keep resolving.
        assert.strictEqual(server.getMaintenance(defaultMaintID).id, defaultMaintID);
        assert.strictEqual(server.getMaintenance(acmeMaintID).id, acmeMaintID);
    });

});
