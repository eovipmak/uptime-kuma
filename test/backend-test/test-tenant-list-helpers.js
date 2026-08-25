/**
 * G1.08 - Tenant listForTenant helper regression tests
 *
 * Regression for KUM-69: every column-based listForTenant helper previously
 * called R.findMany(), an API that does not exist in redbean-node@0.3.3, so
 * any runtime invocation threw "TypeError: R.findMany is not a function".
 * Backend tests never invoked these helpers, which let the defect through CI.
 *
 * These tests invoke EVERY tenant-scoped list helper against a fresh SQLite
 * database and prove:
 *  1. each helper executes without throwing,
 *  2. rows are filtered to the requested tenant (NULL-tenant legacy rows are
 *     excluded),
 *  3. results are ordered by id,
 *  4. Monitor.listForTenantAndUser additionally filters on user_id.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Harness note (pattern of test-maintenance-tenant-map.js): the model chain
// pulls the ESM-only `unlimited-timeout` package — unrequireable on Node < 22
// via plain require(). Intercept that single module id with a native-timer
// stub before the first model require so this suite loads on any supported
// Node. Nothing else is stubbed.
const Module = require("module");
const origModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "unlimited-timeout") {
        // ESM-only upstream; equivalent CJS surface backed by native timers.
        return {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (t) => clearTimeout(t),
        };
    }
    return origModuleLoad.call(this, request, parent, isMain);
};

const Monitor = require("../../server/model/monitor");
const Tag = require("../../server/model/tag");
const Group = require("../../server/model/group");
const DockerHost = require("../../server/model/docker_host");
const Proxy = require("../../server/model/proxy");
const APIKey = require("../../server/model/api_key");
const Maintenance = require("../../server/model/maintenance");
const StatusPage = require("../../server/model/status_page");

/**
 * Create a fresh knex instance backed by a temp SQLite file, wired into
 * redbean-node the same way production does (pattern of
 * test-tenant-migration.js / test-migration.js).
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

// Minimal schemas for every table behind a listForTenant helper. Only the
// columns the helpers read are modeled (id, tenant_id, optional user_id).
const TABLES = {
    monitor: "CREATE TABLE monitor (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, user_id INTEGER, name TEXT)",
    tag: "CREATE TABLE tag (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, name TEXT)",
    "group": "CREATE TABLE \"group\" (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, name TEXT)",
    docker_host: "CREATE TABLE docker_host (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, name TEXT)",
    proxy: "CREATE TABLE proxy (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, name TEXT)",
    api_key: "CREATE TABLE api_key (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, name TEXT)",
    maintenance: "CREATE TABLE maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, title TEXT)",
    status_page: "CREATE TABLE status_page (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, slug TEXT)",
};

describe("tenant listForTenant helpers", () => {

    /** @type {object} knex instance shared by the tests in this file */
    let db;
    const testDbPath = path.join(__dirname, "../../data", "test-tenant-list-helpers.db");
    const TENANT_A = 101;
    const TENANT_B = 202;

    test("setup: create schema and seed three tenants worth of rows", async () => {
        removeTestDbFile(testDbPath);
        db = await createTestKnex(testDbPath);

        for (const ddl of Object.values(TABLES)) {
            await db.schema.raw(ddl);
        }

        // Every table gets: 2 rows in tenant A, 1 row in tenant B, and one
        // legacy row with a NULL tenant_id (must never leak into any tenant).
        for (const table of Object.keys(TABLES)) {
            await db(table).insert([
                { tenant_id: TENANT_A },
                { tenant_id: TENANT_A },
                { tenant_id: TENANT_B },
                { tenant_id: null },
            ]);
        }
    });

    const HELPERS = [
        [ "Monitor", Monitor, "listForTenant" ],
        [ "Tag", Tag, "listForTenant" ],
        [ "Group", Group, "listForTenant" ],
        [ "DockerHost", DockerHost, "listForTenant" ],
        [ "Proxy", Proxy, "listForTenant" ],
        [ "APIKey", APIKey, "listForTenant" ],
        [ "Maintenance", Maintenance, "listForTenant" ],
        [ "StatusPage", StatusPage, "listForTenant" ],
    ];

    for (const [ label, model, method ] of HELPERS) {
        test(`${label}.${method} runs and scopes to the tenant`, async () => {
            const rowsA = await model[method](TENANT_A);
            assert.ok(Array.isArray(rowsA), `${label}: expected array`);
            assert.strictEqual(rowsA.length, 2, `${label}: tenant A sees exactly its 2 rows`);
            assert.deepStrictEqual(
                rowsA.map(r => r.tenant_id),
                [ TENANT_A, TENANT_A ],
                `${label}: all rows belong to tenant A`
            );
            assert.deepStrictEqual(
                rowsA.map(r => r.id),
                [ ...rowsA.map(r => r.id) ].sort((a, b) => a - b),
                `${label}: ordered by id`
            );

            const rowsB = await model[method](TENANT_B);
            assert.strictEqual(rowsB.length, 1, `${label}: tenant B sees exactly its 1 row`);

            // Isolation: the NULL-tenant legacy row belongs to no tenant.
            assert.ok(
                rowsB.every(r => r.tenant_id === TENANT_B),
                `${label}: NULL-tenant row never leaks`
            );
        });
    }

    test("Monitor.listForTenantAndUser filters on user_id within the tenant", async () => {
        const USER_1 = 11;
        const USER_2 = 22;
        await db("monitor").insert([
            { tenant_id: TENANT_A, user_id: USER_1 },
            { tenant_id: TENANT_A, user_id: USER_1 },
            { tenant_id: TENANT_A, user_id: USER_2 },
            { tenant_id: TENANT_B, user_id: USER_1 },
        ]);

        const own = await Monitor.listForTenantAndUser(TENANT_A, USER_1);
        assert.strictEqual(own.length, 2, "returns only the user's monitors");
        assert.ok(own.every(r => r.tenant_id === TENANT_A && r.user_id === USER_1));

        // Tenant scoping wins over user matching: user 11 in tenant B is a
        // different row set from user 11 in tenant A.
        const otherTenant = await Monitor.listForTenantAndUser(TENANT_B, USER_1);
        assert.strictEqual(otherTenant.length, 1);
        assert.strictEqual(otherTenant[0].tenant_id, TENANT_B);
    });

    test("teardown: close database and remove temp file", async () => {
        await db.destroy();
        removeTestDbFile(testDbPath);
    });
});
