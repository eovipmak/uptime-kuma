/**
 * G1.08 - Tenant migration chain test (up -> down -> up)
 *
 * Proves, on SQLite, that the G1 multi-tenant migration chain is:
 *  1. applicable on a fresh database (schema + seed assertions),
 *  2. backward-compatible on a populated database (pre-existing rows are
 *     backfilled into the default tenant),
 *  3. safe to roll back WITHOUT losing any business data,
 *  4. idempotent (re-running the chain reproduces the same end state).
 *
 * Chain under test (do NOT patch them here, see task-08 out-of-scope):
 *  - db/knex_migrations/2026-08-23-0000-create-tenant-tables.js
 *  - db/knex_migrations/2026-08-23-0001-add-tenant-id-columns.js
 *  - db/knex_migrations/2026-08-23-0002-seed-default-tenant.js
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Tables that gained a nullable tenant_id column in 2026-08-23-0001
const TENANT_SCOPED_TABLES = [
    "monitor",
    "group",
    "proxy",
    "docker_host",
    "notification",
    "status_page",
    "maintenance",
    "api_key",
    "tag",
    "remote_browser",
];

const TENANT_ROOT_TABLES = [ "tenant", "tenant_user", "tenant_invitation" ];

const MIGRATION_DIRECTORY = path.join(__dirname, "../../db/knex_migrations");

/**
 * Create a fresh knex instance backed by a temp SQLite file, wired into
 * redbean-node the same way production does (pattern of test-migration.js).
 * @param {string} testDbPath Path of the temp SQLite database file
 * @returns {Promise<object>} knex instance (already R.setup()-wired)
 */
async function createTestKnex(testDbPath) {
    // Use the same SQLite driver as the project
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

    // Setup R (redbean) with the knex instance like production code does,
    // so db/knex_init_db.js createTables() (which uses R.knex internally) works.
    const { R } = require("redbean-node");
    R.setup(db);

    return db;
}

/**
 * Prepare an empty database directory + file path for a test run.
 * @param {string} dbName Base file name of the temp database
 * @returns {string} Full path of the (removed) database file
 */
function prepareTestDbFile(dbName) {
    const testDbPath = path.join(__dirname, "../../data", dbName);
    const testDbDir = path.dirname(testDbPath);

    if (!fs.existsSync(testDbDir)) {
        fs.mkdirSync(testDbDir, { recursive: true });
    }

    removeTestDbFile(testDbPath);
    return testDbPath;
}

/**
 * Remove a temp database file (+ SQLite sidecar files) if present.
 * @param {string} testDbPath Path of the temp SQLite database file
 * @returns {void}
 */
function removeTestDbFile(testDbPath) {
    for (const suffix of [ "", "-wal", "-shm" ]) {
        const p = testDbPath + suffix;
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    }
}

/**
 * Run all pending migrations (like the server's first start).
 * @param {object} db knex instance
 * @returns {Promise<void>}
 */
async function migrateLatest(db) {
    await db.migrate.latest({
        directory: MIGRATION_DIRECTORY,
    });
}

/**
 * Roll back exactly ONE migration: 2026-08-23-0002-seed-default-tenant.js.
 *
 * knex's migrate.rollback() unwinds the WHOLE last batch, and a single
 * migrate.latest() applies everything as one batch - rolling it back would
 * also revert pre-G1 migrations owned by earlier releases. migrate.down()
 * (without name) reverts exactly one migration, and 2026-08-23-0002 sorts
 * last, so one targeted down unwinds precisely the seeding/backfill step.
 *
 * This is the rollback the data-safety claim is about: it detaches business
 * rows (tenant_id -> NULL) while the column itself (added by 0001) still
 * exists, so the NULL state is directly observable.
 * @param {object} db knex instance
 * @returns {Promise<void>}
 */
async function rollbackSeedMigration(db) {
    await db.migrate.down({
        directory: MIGRATION_DIRECTORY,
    });
}

/**
 * Check whether a table exists (SQLite).
 * @param {object} db knex instance
 * @param {string} tableName Name of the table
 * @returns {Promise<boolean>} True if the table exists
 */
async function tableExists(db, tableName) {
    const rows = await db.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [ tableName ]);
    return rows.length > 0;
}

/**
 * Check whether a column exists on a table (dialect-safe via knex columnInfo).
 * @param {object} db knex instance
 * @param {string} tableName Name of the table
 * @param {string} columnName Name of the column
 * @returns {Promise<boolean>} True if the column exists
 */
async function columnExists(db, tableName, columnName) {
    const columns = await db(tableName).columnInfo();
    return Object.prototype.hasOwnProperty.call(columns, columnName);
}

/**
 * Count all rows of a table.
 * @param {object} db knex instance
 * @param {string} tableName Name of the table
 * @returns {Promise<number>} Row count
 */
async function countRows(db, tableName) {
    const rows = await db(tableName).count({ cnt: "*" });
    return Number(rows[0].cnt);
}

/**
 * Get the default tenant row (slug "default").
 * @param {object} db knex instance
 * @returns {Promise<object>} The default tenant row
 */
async function getDefaultTenant(db) {
    return await db("tenant").where("slug", "default").first();
}

describe("Tenant migration chain (G1: up -> down -> up)", () => {

    test("Fresh database: full migration chain creates tenant schema, tenant_id columns and default seed", async () => {
        const testDbPath = prepareTestDbFile("test-tenant-migration-fresh.db");
        const db = await createTestKnex(testDbPath);

        try {
            // Initialize the base schema like a first server start
            const { createTables } = require("../../db/knex_init_db.js");
            await createTables();

            // A fresh install has no users until the setup UI creates the admin.
            // Insert one so migration 2026-08-23-0002 can attach its
            // tenant_admin membership (mirrors fresh-install admin creation).
            const [ adminUserId ] = await db("user").insert({
                username: "admin",
                password: "$2a$10$placeholderhashplaceholderhash00",
                active: 1,
            });

            await migrateLatest(db);

            // The three tenant root tables exist and are queryable
            for (const table of TENANT_ROOT_TABLES) {
                assert.ok(await tableExists(db, table), `table ${table} should exist`);
                await db.select().from(table); // queryable without error
            }

            // Every G1-listed business table gained a tenant_id column
            for (const table of TENANT_SCOPED_TABLES) {
                assert.ok(await columnExists(db, table, "tenant_id"), `table ${table} should have a tenant_id column`);
            }

            // Default tenant row exists with slug "default"
            const defaultTenant = await getDefaultTenant(db);
            assert.ok(defaultTenant, "default tenant row should exist");
            assert.strictEqual(defaultTenant.slug, "default");

            // Existing admin user got a tenant_user membership as tenant_admin
            const membership = await db("tenant_user")
                .where("user_id", adminUserId)
                .where("tenant_id", defaultTenant.id)
                .first();
            assert.ok(membership, "admin user should have a tenant_user row");
            assert.strictEqual(membership.role, "tenant_admin");
        } finally {
            await db.destroy();
            removeTestDbFile(testDbPath);
        }
    });

    test("Populated database + rollback + re-migrate: backfill, no data loss, idempotent end state", async () => {
        const testDbPath = prepareTestDbFile("test-tenant-migration-populated.db");
        const db = await createTestKnex(testDbPath);

        try {
            const { createTables } = require("../../db/knex_init_db.js");
            await createTables();

            // Pre-existing data BEFORE the G1 migrations run (legacy install)
            const [ userId ] = await db("user").insert({
                username: "admin",
                password: "$2a$10$placeholderhashplaceholderhash00",
                active: 1,
            });
            const [ monitorId ] = await db("monitor").insert({
                name: "Legacy Monitor",
                user_id: userId,
                type: "http",
                url: "https://example.com",
                interval: 20,
                active: 1,
            });

            // ---- UP: migrate and verify backward-compatible backfill ----
            await migrateLatest(db);

            const defaultTenant = await getDefaultTenant(db);
            assert.ok(defaultTenant, "default tenant row should exist after migration");

            let monitor = await db("monitor").where("id", monitorId).first();
            assert.ok(monitor, "monitor row should survive migration");
            assert.strictEqual(
                monitor.tenant_id, defaultTenant.id,
                "pre-existing monitor should be backfilled into the default tenant"
            );

            // Counts while tenant_id still exists (used by rollback assertions)
            const userCountBeforeRollback = await countRows(db, "user");
            const monitorCountBeforeRollback = await countRows(db, "monitor");
            assert.strictEqual(userCountBeforeRollback, 1, "sanity: exactly one user before rollback");
            assert.strictEqual(monitorCountBeforeRollback, 1, "sanity: exactly one monitor before rollback");

            // ---- DOWN: roll back exactly the seeding/backfill step (0002) ----
            await rollbackSeedMigration(db);

            // (a) The monitor row still exists with the same id
            monitor = await db("monitor").where("id", monitorId).first();
            assert.ok(monitor, "monitor row must still exist after rollback");
            assert.strictEqual(monitor.name, "Legacy Monitor", "monitor data must be intact after rollback");

            // (b) The backfill was undone: tenant_id is NULL again, and the
            // column itself is still present (only 0002 was rolled back)
            assert.ok(
                await columnExists(db, "monitor", "tenant_id"),
                "tenant_id column must still exist after rolling back only the seed migration"
            );
            assert.strictEqual(monitor.tenant_id, null, "monitor.tenant_id must be NULL after rollback");

            // (c) Zero deletions from user or monitor (identical counts)
            assert.strictEqual(await countRows(db, "user"), userCountBeforeRollback);
            assert.strictEqual(await countRows(db, "monitor"), monitorCountBeforeRollback);

            // Rollback also removed only what 0002 created: memberships + default tenant
            assert.strictEqual(await countRows(db, "tenant_user"), 0, "rollback should remove created memberships");
            assert.strictEqual(await countRows(db, "tenant"), 0, "rollback should remove the default tenant");

            // ---- UP again: idempotency of the full chain end state ----
            await migrateLatest(db);

            const defaultTenantAgain = await getDefaultTenant(db);
            assert.ok(defaultTenantAgain, "default tenant should exist after re-migration");
            assert.strictEqual(defaultTenantAgain.slug, "default");

            // Final state == initial post-migration state:
            // 1 user, 1 monitor, 1 tenant_user, 1 default tenant
            assert.strictEqual(await countRows(db, "user"), 1);
            assert.strictEqual(await countRows(db, "monitor"), 1);
            assert.strictEqual(await countRows(db, "tenant"), 1);
            assert.strictEqual(await countRows(db, "tenant_user"), 1);

            // The surviving monitor is backfilled into the default tenant again
            monitor = await db("monitor").where("id", monitorId).first();
            assert.ok(monitor, "monitor row must still exist after re-migration");
            assert.strictEqual(
                monitor.tenant_id, defaultTenantAgain.id,
                "monitor should be backfilled into the default tenant again"
            );

            // The admin user is a tenant_admin of the default tenant again
            const membership = await db("tenant_user")
                .where("user_id", userId)
                .where("tenant_id", defaultTenantAgain.id)
                .first();
            assert.ok(membership, "user should have a tenant_user row after re-migration");
            assert.strictEqual(membership.role, "tenant_admin");
        } finally {
            await db.destroy();
            removeTestDbFile(testDbPath);
        }
    });
});


