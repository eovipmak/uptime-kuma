/**
 * G2.10 - Tenant resolution middleware tests
 *
 * Proves the ADR-0003 priority chain implemented by
 * server/middleware/resolve-tenant.js against a fresh SQLite database:
 *   subdomain -> custom domain -> X-Tenant-ID header (membership-checked)
 *   -> JWT claim (tid) -> default tenant fallback,
 * plus requireTenantContext() rejection, bearerAuth() identity decoding and
 * the tenant-guard path exemptions.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const {
    DEFAULT_TENANT_SLUG,
    BASE_DOMAIN_ENV,
    extractRequestHostname,
    isSubdomainHostname,
    getMembershipRole,
    resolveTenantIdForInbound,
    resolveTenant,
    requireTenantContext,
    bearerAuth,
    isTenantGuardExemptPath,
} = require("../../server/middleware");
const { Settings } = require("../../server/settings");

/**
 * Create a fresh knex instance backed by a temp SQLite file, wired into
 * redbean-node the same way production does (pattern of
 * test-tenant-list-helpers.js).
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
        if (fs.existsSync(testDbPath + suffix)) {
            fs.rmSync(testDbPath + suffix);
        }
    }
}

/** Minimal schemas for the tables the middleware queries. */
const TABLES = [
    "CREATE TABLE tenant (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, slug TEXT UNIQUE, plan TEXT, status TEXT, custom_domain TEXT)",
    "CREATE TABLE tenant_user (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, tenant_id INTEGER, role TEXT)",
    "CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, password TEXT)",
    "CREATE TABLE setting (`key` TEXT, `value` TEXT)",
];

// Fixture ids
const TENANT_DEFAULT = 1;
const TENANT_ACME = 2;
const TENANT_ZETA = 3;
const USER_ALICE = 11;   // member of default + acme
const USER_BOB = 12;     // member of zeta only

/**
 * Build a fake Express request.
 * @param {object} options Options
 * @param {object} options.headers Request headers
 * @param {string} options.hostname request.hostname
 * @param {object} options.user Already-authenticated principal POJO
 * @returns {object} Fake request with a header() helper
 */
function fakeRequest({ headers = {}, hostname = "", user = undefined } = {}) {
    return {
        headers,
        hostname,
        user,
        header(name) {
            return this.headers[String(name).toLowerCase()];
        },
    };
}

/**
 * Build a fake Express response that records status/json calls.
 * @returns {object} Fake response
 */
function fakeResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

/**
 * Build a fake Express next() that records whether it was called and with
 * which error (arguments beyond position 0 are ignored).
 * @returns {Function} next() with `.state` = { called, error }
 */
function recordingNext() {
    const state = {
        called: false,
        error: undefined,
    };
    const next = (...args) => {
        state.called = true;
        if (args.length > 0) {
            state.error = args[0];
        }
    };
    next.state = state;
    return next;
}

describe("tenant resolution middleware", () => {

    /** @type {object} knex instance shared by the tests in this file */
    let db;
    const testDbPath = path.join(__dirname, "../../data", "test-resolve-tenant-middleware.db");

    /** @type {string|undefined} Original UPTIME_KUMA_BASE_DOMAIN value */
    let originalBaseDomain;

    test("setup: create schema and seed tenants / users / memberships", async () => {
        fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
        removeTestDbFile(testDbPath);
        db = await createTestKnex(testDbPath);

        for (const ddl of TABLES) {
            await db.schema.raw(ddl);
        }

        await db("tenant").insert([
            { id: TENANT_DEFAULT, name: "Default", slug: DEFAULT_TENANT_SLUG, custom_domain: null },
            { id: TENANT_ACME, name: "Acme", slug: "acme", custom_domain: "status.acme.com" },
            { id: TENANT_ZETA, name: "Zeta", slug: "zeta", custom_domain: null },
        ]);
        await db("user").insert([
            { id: USER_ALICE, username: "alice", password: "x" },
            { id: USER_BOB, username: "bob", password: "y" },
        ]);
        await db("tenant_user").insert([
            { user_id: USER_ALICE, tenant_id: TENANT_DEFAULT, role: "tenant_admin" },
            { user_id: USER_ALICE, tenant_id: TENANT_ACME, role: "tenant_admin" },
            { user_id: USER_BOB, tenant_id: TENANT_ZETA, role: "viewer" },
        ]);

        originalBaseDomain = process.env[BASE_DOMAIN_ENV];
    });

    test("isSubdomainHostname disambiguates subdomains from other hosts", () => {
        assert.strictEqual(isSubdomainHostname("acme.status.example.com", "status.example.com"), true);
        assert.strictEqual(isSubdomainHostname("a.b.example.com", "example.com"), true);
        assert.strictEqual(isSubdomainHostname("example.com", "example.com"), false);
        assert.strictEqual(isSubdomainHostname("notexample.com", "example.com"), false);
        assert.strictEqual(isSubdomainHostname("", "example.com"), false);
        assert.strictEqual(isSubdomainHostname("example.com", ""), false);
    });

    test("priority 1: subdomain of the base domain wins over header and JWT claim", async () => {
        process.env[BASE_DOMAIN_ENV] = "example.com";
        try {
            // Bob's claim AND header both say zeta, but the host is Acme's
            // subdomain: first match wins.
            const tenantId = await resolveTenantIdForInbound(
                { hostname: "acme.example.com", tenantHeader: "zeta" },
                { user: { id: USER_BOB, tid: TENANT_ZETA } }
            );
            assert.strictEqual(tenantId, TENANT_ACME);
        } finally {
            delete process.env[BASE_DOMAIN_ENV];
        }
    });

    test("priority 1 miss falls through: unknown subdomain label does not resolve", async () => {
        process.env[BASE_DOMAIN_ENV] = "example.com";
        try {
            const tenantId = await resolveTenantIdForInbound(
                { hostname: "ghost.example.com", tenantHeader: null },
                { user: { id: USER_ALICE } }
            );
            assert.strictEqual(tenantId, TENANT_DEFAULT);
        } finally {
            delete process.env[BASE_DOMAIN_ENV];
        }
    });

    test("priority 2: custom domain matches when host is not a subdomain", async () => {
        process.env[BASE_DOMAIN_ENV] = "example.com";
        try {
            const tenantId = await resolveTenantIdByHost("status.acme.com");
            assert.strictEqual(tenantId, TENANT_ACME);
        } finally {
            delete process.env[BASE_DOMAIN_ENV];
        }
    });

    test("priority 2: hostname matching is case-insensitive", async () => {
        const tenantId = await resolveTenantIdByHost("STATUS.ACME.COM");
        assert.strictEqual(tenantId, TENANT_ACME);
    });

    test("base domain unset: every hostname is treated as a custom-domain lookup", async () => {
        delete process.env[BASE_DOMAIN_ENV];
        const matched = await resolveTenantIdByHost("status.acme.com");
        assert.strictEqual(matched, TENANT_ACME);

        const unknown = await resolveTenantIdByHost("unrelated.example.org");
        assert.strictEqual(unknown, TENANT_DEFAULT);
    });

    test("priority 3: X-Tenant-ID header resolves for a member (slug and numeric forms)", async () => {
        const bySlug = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: "zeta" },
            { user: { id: USER_BOB } }
        );
        assert.strictEqual(bySlug, TENANT_ZETA);

        const byId = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: String(TENANT_ACME) },
            { user: { id: USER_ALICE } }
        );
        assert.strictEqual(byId, TENANT_ACME);
    });

    test("priority 3 guard: header naming a non-member tenant is IGNORED, not trusted", async () => {
        // Alice is not a member of zeta: the header must be ignored and the
        // chain falls through to her default tenant - never to zeta.
        const tenantId = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: "zeta" },
            { user: { id: USER_ALICE } }
        );
        assert.strictEqual(tenantId, TENANT_DEFAULT);
        assert.notStrictEqual(tenantId, TENANT_ZETA);
    });

    test("priority 3 guard: anonymous requests can NEVER use the header", async () => {
        const tenantId = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: "zeta" },
            { user: null }
        );
        assert.strictEqual(tenantId, TENANT_DEFAULT);
        assert.notStrictEqual(tenantId, TENANT_ZETA);
    });

    test("priority 4: signed JWT claim (tid) resolves without extra membership query", async () => {
        const tenantId = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: null },
            { user: { id: USER_BOB, tid: TENANT_ZETA } }
        );
        assert.strictEqual(tenantId, TENANT_ZETA);
    });

    test("priority 4: legacy token without tid falls through to the default tenant", async () => {
        const tenantId = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: null },
            { user: { id: USER_ALICE } }
        );
        assert.strictEqual(tenantId, TENANT_DEFAULT);
    });

    test("priority 4: stale tid pointing at a deleted tenant falls through", async () => {
        const tenantId = await resolveTenantIdForInbound(
            { hostname: null, tenantHeader: null },
            { user: { id: USER_BOB, tid: 9999 } }
        );
        assert.strictEqual(tenantId, TENANT_DEFAULT);
    });

    /**
     * Helper wrapping resolveTenantIdForInbound for hostname-only tests.
     * @param {string} hostname Lower-cased hostname under test
     * @returns {Promise<number|null>} Resolved tenant id
     */
    async function resolveTenantIdByHost(hostname) {
        return await resolveTenantIdForInbound(
            { hostname, tenantHeader: null },
            { user: null }
        );
    }

    test("getMembershipRole returns the role inside the resolved tenant", async () => {
        assert.strictEqual(await getMembershipRole(USER_ALICE, TENANT_ACME), "tenant_admin");
        assert.strictEqual(await getMembershipRole(USER_ALICE, TENANT_ZETA), null);
    });

    test("extractRequestHostname honors trustProxy + X-Forwarded-Host (first entry, port stripped)", async () => {
        // trustProxy off: use request.hostname
        let hostname = await extractRequestHostname(fakeRequest({
            headers: { "x-forwarded-host": "spoofed.example.com" },
            hostname: "real.example.com",
        }));
        assert.strictEqual(hostname, "real.example.com");

        // trustProxy on: use the first XFH entry, stripped of its port
        await db("setting").insert({ key: "trustProxy", value: "true" });
        Settings.cacheList = {};
        try {
            hostname = await extractRequestHostname(fakeRequest({
                headers: { "x-forwarded-host": "acme.example.com:3000, proxy.example.com" },
                hostname: "ignored.example.com",
            }));
            assert.strictEqual(hostname, "acme.example.com");
        } finally {
            await db("setting").where({ key: "trustProxy" }).del();
            Settings.cacheList = {};
        }
    });

    test("resolveTenant() middleware stores tenantId (+role) on request.user", async () => {
        process.env[BASE_DOMAIN_ENV] = "example.com";
        try {
            const request = fakeRequest({
                headers: {},
                hostname: "acme.example.com",
                user: { id: USER_ALICE },
            });
            const next = recordingNext();

            await resolveTenant()(request, fakeResponse(), next);

            assert.ok(!next.state.error, "next() called without error");
            assert.strictEqual(request.user.tenantId, TENANT_ACME);
            assert.strictEqual(request.user.role, "tenant_admin");

            // Idempotent: a second application keeps the existing context.
            request.hostname = "zeta.example.com";
            await resolveTenant()(request, fakeResponse(), next);
            assert.strictEqual(request.user.tenantId, TENANT_ACME);
        } finally {
            delete process.env[BASE_DOMAIN_ENV];
        }
    });

    test("requireTenantContext() rejects missing context with TranslatableError", async () => {
        const TranslatableError = require("../../server/translatable-error");

        let captured = undefined;
        const next = (err) => {
            captured = err;
        };

        requireTenantContext()(fakeRequest({}), fakeResponse(), next);
        assert.ok(captured instanceof TranslatableError, "error is a TranslatableError");
        assert.strictEqual(captured.message, "tenantContextRequired");
        assert.strictEqual(captured.meta.status, 400);

        captured = undefined;
        requireTenantContext()(fakeRequest({ user: { tenantId: TENANT_ACME } }), fakeResponse(), next);
        assert.strictEqual(captured, undefined, "guard passes when context exists");
    });

    test("bearerAuth() decodes a valid Bearer JWT into request.user", async () => {
        const token = jwt.sign(
            { username: "alice", h: "hash", tid: TENANT_ACME, role: "tenant_admin" },
            "test-secret"
        );
        const request = fakeRequest({ headers: { authorization: `Bearer ${token}` } });
        const next = recordingNext();

        await bearerAuth({ secretProvider: () => "test-secret" })(request, fakeResponse(), next);

        assert.ok(next.state.called && !next.state.error);
        assert.strictEqual(request.user.id, USER_ALICE);
        assert.strictEqual(request.user.username, "alice");
        assert.strictEqual(request.user.tid, TENANT_ACME);
        assert.strictEqual(request.user.role, "tenant_admin");
    });

    test("bearerAuth() rejects an invalid token with 401 instead of downgrading to anonymous", async () => {
        const token = jwt.sign({ username: "alice" }, "wrong-secret");
        const request = fakeRequest({ headers: { authorization: `Bearer ${token}` } });
        const response = fakeResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        await bearerAuth({ secretProvider: () => "test-secret" })(request, response, next);

        assert.strictEqual(nextCalled, false);
        assert.strictEqual(response.statusCode, 401);
        assert.strictEqual(response.body.msg, "authInvalidToken");
    });

    test("bearerAuth() passes requests without the header through untouched", async () => {
        const request = fakeRequest({ headers: {} });
        const next = recordingNext();

        await bearerAuth({ secretProvider: () => "test-secret" })(request, fakeResponse(), next);

        assert.ok(next.state.called && !next.state.error);
        assert.strictEqual(request.user, undefined);
    });

    test("isTenantGuardExemptPath exempts public endpoints and non-API paths only", () => {
        // Public / anonymous endpoints stay reachable
        assert.strictEqual(isTenantGuardExemptPath("/api/entry-page"), true);
        assert.strictEqual(isTenantGuardExemptPath("/api/entry-page?x=1"), true);
        assert.strictEqual(isTenantGuardExemptPath("/api/push/abc123"), true);
        assert.strictEqual(isTenantGuardExemptPath("/api/badge/1/status"), true);
        assert.strictEqual(isTenantGuardExemptPath("/api/status-page/home"), true);

        // Non-API paths never reach the guard at all
        assert.strictEqual(isTenantGuardExemptPath("/"), true);
        assert.strictEqual(isTenantGuardExemptPath("/dashboard"), true);
        assert.strictEqual(isTenantGuardExemptPath("/status/homepage"), true);

        // Business API paths are guarded
        assert.strictEqual(isTenantGuardExemptPath("/api/switch-tenant"), false);
        assert.strictEqual(isTenantGuardExemptPath("/api/monitors"), false);
        assert.strictEqual(isTenantGuardExemptPath("/api/status-page-decoy"), false);
    });

    test("teardown: restore env, stop settings cache timer, close database", async () => {
        if (originalBaseDomain === undefined) {
            delete process.env[BASE_DOMAIN_ENV];
        } else {
            process.env[BASE_DOMAIN_ENV] = originalBaseDomain;
        }
        if (Settings.cacheCleaner) {
            clearInterval(Settings.cacheCleaner);
            Settings.cacheCleaner = null;
        }
        Settings.cacheList = {};
        await db.destroy();
        removeTestDbFile(testDbPath);
    });
});
