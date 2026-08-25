/**
 * KUM-100 - getMonitorJSONList tenant filter regression tests
 *
 * UptimeKumaServer.getMonitorJSONList(userID) previously filtered only on
 * user_id, so a user belonging to multiple tenants received monitors from ALL
 * of their tenants in the dashboard monitorList socket event, regardless of
 * the active tenant (socket.tenantID).
 *
 * Against a fresh SQLite database carrying the full real migration chain,
 * these tests prove:
 *  1. monitors from another tenant are NOT returned when filtering by the
 *     active tenant,
 *  2. same-tenant monitors ARE returned and user_id still applies,
 *  3. legacy NULL-tenant rows are excluded from a tenant-scoped query
 *     (strict equality, matching Monitor.listForTenantAndUser),
 *  4. calling without a tenantID keeps the legacy behavior (no tenant
 *     filtering), so non-socket callers stay unaffected.
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
 * test-tenant-list-helpers.js / test-tenant-migration.js).
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

    // Register server/model/* BeanModels (Monitor extends BeanModel), the
    // same thing Database.connect() does via autoloadModels in production.
    // Without this, R.find() returns plain beans whose toJSON is missing.
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

describe("getMonitorJSONList tenant filter", () => {

    /** @type {object} knex instance shared by the tests in this file */
    let db;
    const testDbPath = path.join(__dirname, "../../data", "test-monitor-json-list-tenant-filter.db");

    // The method under test only touches R + static model helpers, so it is
    // invoked off the prototype with an inert `this`.
    const getMonitorJSONList = UptimeKumaServer.prototype.getMonitorJSONList;

    let defaultTenantID;
    const TENANT_B_ID = 202; // secondary "acme" tenant inserted below
    const USER_1 = 11; // member of both the default tenant and tenant B
    const USER_2 = 22; // member of the default tenant only

    test("setup: base schema + full migration chain + seed multi-tenant data", async () => {
        removeTestDbFile(testDbPath);
        const testDbDir = path.dirname(testDbPath);
        if (!fs.existsSync(testDbDir)) {
            fs.mkdirSync(testDbDir, { recursive: true });
        }
        db = await createTestKnex(testDbPath);

        // Initialize the base schema like a first server start
        const { createTables } = require("../../db/knex_init_db.js");
        await createTables();

        // A fresh install has no users until the setup UI creates the admin.
        // Insert one so migration 2026-08-23-0002 can attach its membership.
        await db("user").insert({
            username: "admin",
            password: "$2a$10$placeholderhashplaceholderhash00",
            active: 1,
        });

        // Apply the full real migration chain (creates tenant tables, seeds
        // the default tenant, backfills memberships, repairs KUM-75 rows).
        await db.migrate.latest({ directory: MIGRATION_DIRECTORY });

        const defaultTenant = await db("tenant").where("slug", "default").first();
        assert.ok(defaultTenant, "default tenant should exist after migrations");
        defaultTenantID = defaultTenant.id;

        // Second tenant + memberships: user 1 belongs to BOTH tenants (the
        // leak scenario); user 2 only to the default tenant.
        await db("tenant").insert({ name: "Acme", slug: "acme" });
        await db("tenant_user").insert([
            { tenant_id: defaultTenantID, user_id: USER_1, role: "tenant_admin" },
            { tenant_id: TENANT_B_ID, user_id: USER_1, role: "tenant_admin" },
            { tenant_id: defaultTenantID, user_id: USER_2, role: "tenant_admin" },
        ]);

        // Monitors: user 1 owns rows in both tenants plus one legacy
        // NULL-tenant row created by the pre-KUM-100 "add" handler.
        await db("monitor").insert([
            { name: "default-a", type: "http", url: "https://a.example", user_id: USER_1, tenant_id: defaultTenantID },
            { name: "default-b", type: "http", url: "https://b.example", user_id: USER_2, tenant_id: defaultTenantID },
            { name: "acme-x", type: "http", url: "https://x.acme.example", user_id: USER_1, tenant_id: TENANT_B_ID },
            { name: "legacy-null", type: "http", url: "https://legacy.example", user_id: USER_1, tenant_id: null },
        ]);
    });

    test("monitors from another tenant are NOT returned for the active tenant", async () => {
        const list = await getMonitorJSONList.call({}, USER_1, defaultTenantID);
        const names = Object.values(list).map((m) => m.name);

        assert.ok(!names.includes("acme-x"), "tenant B monitor must not leak into default tenant list");
        assert.ok(!names.includes("legacy-null"), "NULL-tenant monitor must not leak into default tenant list");
    });

    test("same-tenant monitors ARE returned and user_id still applies", async () => {
        const listUser1 = await getMonitorJSONList.call({}, USER_1, defaultTenantID);
        assert.deepStrictEqual(
            Object.values(listUser1).map((m) => m.name),
            [ "default-a" ],
            "user 1 sees exactly their own default-tenant monitor"
        );

        const listUser2 = await getMonitorJSONList.call({}, USER_2, defaultTenantID);
        assert.deepStrictEqual(
            Object.values(listUser2).map((m) => m.name),
            [ "default-b" ],
            "user 2 sees exactly their own default-tenant monitor"
        );
    });

    test("legacy NULL-tenant rows are excluded from a tenant-scoped query", async () => {
        const list = await getMonitorJSONList.call({}, USER_1, TENANT_B_ID);
        const names = Object.values(list).map((m) => m.name);

        assert.ok(!names.includes("legacy-null"), "strict tenant equality excludes NULL-tenant rows");
        assert.ok(names.includes("acme-x"), "owning tenant still sees its own monitor");
    });

    test("calling without tenantID keeps legacy unfiltered-by-tenant behavior", async () => {
        const list = await getMonitorJSONList.call({}, USER_1);
        const names = Object.values(list).map((m) => m.name).sort();

        assert.deepStrictEqual(
            names,
            [ "acme-x", "default-a", "legacy-null" ],
            "no tenant arg returns every monitor owned by the user across tenants"
        );
    });

    test("teardown: close database and remove temp file", async () => {
        await db.destroy();
        removeTestDbFile(testDbPath);
    });
});

describe("repair-null-tenant-monitors migration", () => {

    /** @type {object} knex instance shared by the tests in this file */
    let db;
    const testDbPath = path.join(__dirname, "../../data", "test-repair-null-tenant-monitors-migration.db");

    // Migrations are sorted by filename, so this is the last one BEFORE the
    // repair migration under test.
    const REPAIR_MIGRATION_NAME = "2026-08-25-0100-repair-null-tenant-monitors.js";
    const PREVIOUS_MIGRATION_NAME = "2026-08-25-0000-repair-demo-seeded-tcp-monitor-type.js";
    const repair = require("../../db/knex_migrations/" + REPAIR_MIGRATION_NAME);

    // knex 3.x quirks: migrate.latest() ignores a `name` option and
    // migrate.up({ name }) misfires on already-applied migrations, so the
    // pre-repair staging below excludes the repair migration via a filtered
    // migration source instead. Note that knex resets a custom
    // migrationSource back to its FS source whenever a `directory` option
    // is also present, so only the source is passed here.
    /**
     * Apply the whole real migration chain except the repair migration under
     * test, staging the exact pre-KUM-100 database state.
     * @param {object} db knex instance
     * @returns {Promise<void>} resolves when every staged migration is applied
     */
    async function migrateLatestExceptRepair(db) {
        const files = fs.readdirSync(MIGRATION_DIRECTORY)
            .filter((f) => f.endsWith(".js") && f !== REPAIR_MIGRATION_NAME)
            .sort();
        await db.migrate.latest({
            migrationSource: {
                getMigrations() {
                    return files;
                },
                getMigrationName(migration) {
                    return migration;
                },
                getMigration(migration) {
                    return require(path.join(MIGRATION_DIRECTORY, migration));
                },
            },
        });
    }

    let defaultTenantID;
    let tenantBID;
    const USER_WITH_MEMBERSHIP = 31; // member of default + B -> primary = lowest id
    const USER_WITHOUT_MEMBERSHIP = 32; // no tenant_user rows at all

    test("setup: base schema + migrations up to (excluding) the repair", async () => {
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

        // Run every migration EXCEPT the repair under test, leaving the
        // database in the exact pre-KUM-100 state.
        await migrateLatestExceptRepair(db);

        const applied = (await db("knex_migrations").select("name")).map((r) => r.name);
        assert.ok(applied.includes(PREVIOUS_MIGRATION_NAME), "previous migration applied");
        assert.ok(!applied.includes(REPAIR_MIGRATION_NAME), "repair migration must not have run yet");

        // Second tenant + memberships: user 31 in both tenants (primary =
        // lowest tenant_id), user 32 deliberately has NO membership.
        const defaultTenant = await db("tenant").where("slug", "default").first();
        defaultTenantID = defaultTenant.id;
        await db("tenant").insert({ name: "Acme", slug: "acme" });
        const acmeTenant = await db("tenant").where("slug", "acme").first();
        tenantBID = acmeTenant.id;

        await db("tenant_user").insert([
            { tenant_id: tenantBID, user_id: USER_WITH_MEMBERSHIP, role: "tenant_admin" },
            { tenant_id: defaultTenantID, user_id: USER_WITH_MEMBERSHIP, role: "tenant_admin" },
        ]);

        // Orphan monitors created by the pre-KUM-100 "add" handler.
        await db("monitor").insert([
            { name: "orphan-member", type: "http", url: "https://m.example", user_id: USER_WITH_MEMBERSHIP, tenant_id: null },
            { name: "orphan-no-membership", type: "http", url: "https://n.example", user_id: USER_WITHOUT_MEMBERSHIP, tenant_id: null },
        ]);
    });

    test("up(): NULL-tenant rows go to owner's primary tenant / default fallback", async () => {
        await repair.up(db);

        const orphanMember = await db("monitor").where("name", "orphan-member").first();
        assert.strictEqual(
            orphanMember.tenant_id,
            defaultTenantID,
            "owner's primary tenant = lowest tenant_id membership (default < acme)"
        );

        const orphanNoMembership = await db("monitor").where("name", "orphan-no-membership").first();
        assert.strictEqual(
            orphanNoMembership.tenant_id,
            defaultTenantID,
            "owner without membership falls back to the default tenant"
        );
    });

    test("up() is idempotent", async () => {
        await repair.up(db);

        const tenants = await db("monitor")
            .whereIn("name", [ "orphan-member", "orphan-no-membership" ])
            .select("name", "tenant_id");
        assert.deepStrictEqual(
            tenants.sort((a, b) => a.name.localeCompare(b.name)),
            [
                { name: "orphan-member", tenant_id: defaultTenantID },
                { name: "orphan-no-membership", tenant_id: defaultTenantID },
            ],
            "re-running up() leaves repaired rows untouched"
        );
    });

    test("down() leaves data untouched", async () => {
        await repair.down(db);

        const remaining = await db("monitor")
            .whereIn("name", [ "orphan-member", "orphan-no-membership" ])
            .whereNotNull("tenant_id");
        assert.strictEqual(remaining.length, 2, "down() must not NULL out repaired rows");
    });

    test("teardown: close database and remove temp file", async () => {
        await db.destroy();
        removeTestDbFile(testDbPath);
    });
});
