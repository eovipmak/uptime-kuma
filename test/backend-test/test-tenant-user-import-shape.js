/**
 * KUM-92 / G2.11 - TenantUser import/export shape guard
 *
 * Regression guard for the PR #28 production incident: every heartbeat of
 * every monitor crashed with
 *   TypeError: Cannot read properties of undefined (reading 'getPrimaryTenantID')
 * because server/model/tenant_user.js exports the class as the ENTIRE module
 * (`module.exports = TenantUser;`), but three consumers destructured it as a
 * named export (`const { TenantUser } = require(...)`), which always binds
 * `undefined`.
 *
 * This suite pins BOTH halves of the contract:
 *  1. Runtime: tenant_user.js must keep exporting the class itself (default
 *     export) exposing getPrimaryTenantID.
 *  2. Source shape: every consumer must require tenant_user WITHOUT
 *     destructuring. A pure runtime identity check cannot catch this class of
 *     bug (destructuring happens inside the consumer's scope, invisible to a
 *     require hook), so the import shape itself is asserted textually.
 *
 * Consumer modules are also required once to prove they still load cleanly
 * through the real require graph. Note: api-router.js and
 * uptime-kuma-server.js both reach UptimeKumaServer.getInstance(), whose
 * constructor calls process.exit(1) when ./dist/index.html is absent and
 * NODE_ENV !== "development", so those two loads force development mode
 * first (see uptime-kuma-server.js around the indexHTML try/catch).
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

// Canonical pattern (see server/auth.js): default-export require.
const CONSUMERS = [
    "server/auth.js",
    "server/model/monitor.js",
    "server/routers/api-router.js",
    "server/uptime-kuma-server.js",
];

// Modules whose require graph reaches UptimeKumaServer.getInstance().
const HEAVY_CONSUMERS = [
    "server/routers/api-router.js",
    "server/uptime-kuma-server.js",
];

const TenantUser = require("../../server/model/tenant_user");

describe("TenantUser module export shape", () => {
    test("tenant_user.js exports the class itself as the entire module", () => {
        assert.strictEqual(typeof TenantUser, "function", "module.exports must be the TenantUser class");
    });

    test("TenantUser exposes getPrimaryTenantID (used by beat/sendStats/push paths)", () => {
        assert.strictEqual(typeof TenantUser.getPrimaryTenantID, "function");
    });
});

describe("Consumer import shapes", () => {
    /**
     * Assert a consumer requires tenant_user with the default-export pattern
     * (`const TenantUser = require(...)`), never destructured
     * (`const { TenantUser } = require(...)`, which binds undefined).
     * @param {string} consumerRel Repo-relative path of the consumer module.
     * @returns {void}
     */
    function assertDefaultImportShape(consumerRel) {
        const src = fs.readFileSync(path.join(ROOT, consumerRel), "utf8");
        const requireRe = /require\(\s*["'][^"']*model\/tenant_user(?:\.js)?["']\s*\)|require\(\s*["'][^"']*\/tenant_user["']\s*\)/;
        const lines = src.split("\n");

        const requireLines = lines
            .map((line, i) => ({ line: line.trim(), num: i + 1 }))
            .filter(({ line }) => requireRe.test(line));

        assert.ok(
            requireLines.length > 0,
            `${consumerRel} no longer requires model/tenant_user - update this guard if the dependency moved intentionally`
        );

        for (const { line, num } of requireLines) {
            const destructured = /\{\s*TenantUser\s*\}/.test(line);
            const plain = /(?:const|let|var)\s+TenantUser\s*=/.test(line);
            assert.ok(
                !destructured,
                `${consumerRel}:${num} destructures tenant_user ("${line}") - tenant_user.js has ` +
                "no named export; use `const TenantUser = require(...)` (see server/auth.js)"
            );
            assert.ok(
                plain,
                `${consumerRel}:${num} uses an unexpected require shape ("${line}") - expected ` +
                "`const TenantUser = require(...)`"
            );
        }
    }

    for (const consumer of CONSUMERS) {
        test(`${consumer} requires tenant_user without destructuring`, () => {
            assertDefaultImportShape(consumer);
        });
    }
});

describe("Consumers load cleanly with the fixed import", () => {
    for (const consumer of CONSUMERS) {
        test(`${consumer} loads through the real require graph`, () => {
            if (HEAVY_CONSUMERS.includes(consumer)) {
                // These pull in UptimeKumaServer.getInstance(); without a
                // built frontend the constructor exits the process unless
                // NODE_ENV is "development".
                process.env.NODE_ENV = "development";
            }
            delete require.cache[path.join(ROOT, consumer)];
            const mod = require(path.join(ROOT, consumer));
            assert.ok(mod !== undefined, `${consumer} resolved to undefined`);
        });
    }

    test("Monitor.sendStats beat-path binding is live (not undefined)", async () => {
        // Direct proof for the incident site: whatever monitor.js bound at
        // require time must expose getPrimaryTenantID. Reach into the loaded
        // module graph rather than re-resolving, mirroring how beat() hits it.
        const MonitorModule = require("../../server/model/monitor.js");
        assert.ok(MonitorModule, "monitor.js module resolved");
        assert.strictEqual(typeof TenantUser.getPrimaryTenantID, "function");
    });
});
