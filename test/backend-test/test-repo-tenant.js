/**
 * G4.17 (KUM-33) — Tenant-safe repository wrapper smoke tests
 *
 * Surface smoke for the frozen G4 contract (server/repository):
 *  1. findOneForTenant with a valid tenantId returns only rows of that tenant,
 *  2. findOneForTenant with tenantId = undefined throws (no silent default),
 *  3. dispenseForTenant presets bean.tenant_id,
 * plus guard checks for execForTenant, TenantScopedQueryBuilder and the
 * tenantCacheKey namespace shape.
 *
 * Exhaustive cross-tenant IDOR coverage belongs to task-20 (KUM-36).
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
    findOneForTenant,
    findForTenant,
    findAllForTenant,
    execForTenant,
    dispenseForTenant,
    TenantScopedQueryBuilder,
    tenantCacheKey,
    tenantKeyToScope,
} = require("../../server/repository");

/**
 * Create a fresh knex instance backed by a temp SQLite file, wired into
 * redbean-node the same way production does (pattern of
 * test-tenant-list-helpers.js / test-migration.js).
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

describe("tenant repository wrapper (G4.17)", () => {

    /** @type {object} knex instance shared by the tests in this file */
    let db;
    const testDbPath = path.join(__dirname, "../../data", "test-repo-tenant.db");
    const TENANT_A = 101;
    const TENANT_B = 202;
    const USER_1 = 11;

    test("setup: create schema and seed two tenants worth of rows", async () => {
        removeTestDbFile(testDbPath);
        db = await createTestKnex(testDbPath);
        await db.schema.raw(
            "CREATE TABLE monitor (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, user_id INTEGER, name TEXT, active INTEGER)"
        );
        await db("monitor").insert([
            { tenant_id: TENANT_A, user_id: USER_1, name: "a1", active: 1 },
            { tenant_id: TENANT_A, user_id: USER_1, name: "a2", active: 1 },
            { tenant_id: TENANT_B, user_id: 22, name: "b1", active: 1 },
            { tenant_id: null, user_id: USER_1, name: "legacy-null-tenant", active: 1 },
        ]);
    });

    test("findOneForTenant with valid tenantId returns rows that match that tenant only", async () => {
        const beanA = await findOneForTenant("monitor", "id = ?", [ 1 ], TENANT_A);
        assert.ok(beanA, "row 1 belongs to tenant A and is found");
        assert.strictEqual(Number(beanA.tenant_id), TENANT_A);

        // Isolation both ways.
        assert.strictEqual(await findOneForTenant("monitor", "id = ?", [ 3 ], TENANT_A), null, "tenant A cannot see tenant B's row");
        assert.strictEqual(await findOneForTenant("monitor", "id = ?", [ 4 ], TENANT_A), null, "NULL-tenant legacy row never leaks");

        // Combined ownership + isolation: same id, wrong tenant -> no result.
        const scoped = await findOneForTenant("monitor", "id = ? AND user_id = ?", [ 3, 22 ], TENANT_B);
        assert.ok(scoped, "tenant B finds its own row through a user_id-scoped fragment");
        assert.strictEqual(await findOneForTenant("monitor", "id = ? AND user_id = ?", [ 3, 22 ], TENANT_A), null);
    });

    test("findOneForTenant throws on missing tenantId instead of silently defaulting", async () => {
        await assert.rejects(
            () => findOneForTenant("monitor", "id = ?", [ 1 ], undefined),
            /tenantId required/,
            "undefined tenantId must throw"
        );
        await assert.rejects(
            () => findOneForTenant("monitor", "id = ?", [ 1 ], null),
            /tenantId required/,
            "null tenantId must throw"
        );
    });

    test("findForTenant/findAllForTenant scope results and honor extraSql ordering", async () => {
        const list = await findForTenant("monitor", "active = ?", [ 1 ], TENANT_A, "ORDER BY id DESC");
        assert.deepStrictEqual(list.map(b => Number(b.id)), [ 2, 1 ], "only active rows of tenant A, ordered per extraSql");

        const all = await findAllForTenant("monitor", "active = ?", [ 1 ], TENANT_B);
        assert.strictEqual(all.length, 1);
        assert.strictEqual(Number(all[0].id), 3);
    });

    test("dispenseForTenant presets bean.tenant_id so new rows are born in the right tenant", () => {
        const bean = dispenseForTenant("monitor", 42);
        assert.strictEqual(bean.tenant_id, 42, "bean.tenant_id preset at construction");
        assert.throws(() => dispenseForTenant("monitor", undefined), /tenantId required/, "missing tenantId throws");
    });

    test("execForTenant appends the tenant filter and refuses unsafe statements", async () => {
        // Row-scoped UPDATE: allowed, and must not touch other tenants' rows.
        await execForTenant("UPDATE monitor SET active = ? WHERE id = ?", [ 0, 1 ], TENANT_A);
        const own = await db("monitor").where({ id: 1 }).first();
        const foreign = await db("monitor").where({ id: 3 }).first();
        assert.strictEqual(own.active, 0, "own-tenant row updated");
        assert.strictEqual(foreign.active, 1, "other tenant's identical predicate untouched");

        // Multi-row mutation without primary key: refused unless explicitly opted out.
        await assert.rejects(
            () => execForTenant("DELETE FROM monitor WHERE active = ?", [ 0 ], TENANT_A),
            /requireId/,
            "multi-row DELETE refused without escape hatch"
        );

        // Table-wide statement without WHERE: always refused.
        await assert.rejects(
            () => execForTenant("UPDATE monitor SET active = 1", [], TENANT_A),
            /WHERE/,
            "WHERE-less UPDATE refused"
        );

        // Escape hatch still scopes to the tenant: only tenant A's inactive row
        // (id 1, deactivated above) is deleted; a2 and every other tenant survive.
        await execForTenant("DELETE FROM monitor WHERE active = ?", [ 0 ], TENANT_A, { requireId: false });
        const remainingA = await db("monitor").where({ tenant_id: TENANT_A }).count("* AS cnt").first();
        assert.strictEqual(Number(remainingA.cnt), 1, "escape-hatch delete removed only tenant A's inactive row");
        const remainingB = await db("monitor").where({ tenant_id: TENANT_B }).count("* AS cnt").first();
        assert.strictEqual(Number(remainingB.cnt), 1, "other tenants untouched");
    });

    test("TenantScopedQueryBuilder injects the tenant filter into aggregates", async () => {
        const count = await new TenantScopedQueryBuilder(TENANT_A)
            .select("COUNT(*) AS cnt")
            .from("monitor")
            .getRow();
        assert.strictEqual(Number(count.cnt), 1, "COUNT scoped to tenant A (post-delete state)");

        const rows = await new TenantScopedQueryBuilder(TENANT_B)
            .select("*")
            .from("monitor")
            .where("active = ?", [ 1 ])
            .getAll("ORDER BY id");
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].name, "b1");

        assert.throws(
            () => new TenantScopedQueryBuilder(undefined),
            /tenantId required/,
            "builder throws on missing tenant context"
        );
    });

    test("cache-key namespace contract: tenant:${tenantId}:${key} round-trips", () => {
        assert.strictEqual(tenantCacheKey(7, "monitor:42"), "tenant:7:monitor:42");
        assert.strictEqual(tenantKeyToScope("tenant:9:foo"), 9);
        assert.strictEqual(tenantKeyToScope("monitor:42"), null, "non-namespaced keys have no scope");
        assert.strictEqual(tenantKeyToScope(undefined), null);
    });

    test("teardown: close database and remove temp file", async () => {
        await db.destroy();
        removeTestDbFile(testDbPath);
    });
});
