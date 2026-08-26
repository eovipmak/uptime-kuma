/**
 * KUM-209 - Proxy.reloadProxy() tenant-partitioned iteration regression tests
 *
 * G5.21 partitioned the engine map into server.monitorListByTenant and left
 * the flat `monitorList` getter as a deprecated view over the DEFAULT tenant
 * bucket. Proxy.reloadProxy() still iterated that flat getter, so after a
 * proxy save/delete only default-tenant monitors had their in-memory
 * proxy_id refreshed from the database — non-default tenants kept running
 * monitors with a stale (deleted) proxy config until manually restarted.
 *
 * These tests prove (pure in-memory mocks, no database or server):
 *  1. monitors in EVERY tenant bucket get their proxy_id refreshed from the
 *     DB assoc list,
 *  2. the default-tenant path behaves exactly as before (unchanged),
 *  3. monitors absent from the DB list are left untouched.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

// Harness note (pattern of test-monitor-json-list-tenant-filter.js): the
// model chain pulls the ESM-only `unlimited-timeout` package — unrequireable
// on Node < 22 via plain require(). Intercept that single module id with a
// native-timer stub before the first server require so this suite loads on
// any supported Node. Nothing else is stubbed.
const Module = require("module");
const origModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "unlimited-timeout") {
        return {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (t) => clearTimeout(t),
        };
    }
    return origModuleLoad.call(this, request, parent, isMain);
};

const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
const { R } = require("redbean-node");
const { Proxy } = require("../../server/proxy");

describe("Proxy.reloadProxy", () => {

    test("refreshes proxy_id for monitors in every tenant bucket", async () => {
        // Tenant 1 = default tenant, tenant 2 = another tenant. Both buckets
        // hold one monitor whose proxy was deleted (999) and one unaffected
        // monitor (proxy_id null).
        const fakeServer = {
            monitorListByTenant: {
                1: {
                    11: { id: 11, proxy_id: 999 },
                    12: { id: 12, proxy_id: null },
                },
                2: {
                    21: { id: 21, proxy_id: 999 },
                    22: { id: 22, proxy_id: null },
                },
            },
        };
        UptimeKumaServer.instance = fakeServer;

        const originalGetAssoc = R.getAssoc;
        let capturedSql = null;
        // Simulated global DB state after Proxy.delete(): monitor 11 was
        // re-pointed to proxy 777, monitor 21 lost its proxy (null), monitor
        // 22 gained proxy 888; monitor 12 has no row (never proxied).
        R.getAssoc = async (sql) => {
            capturedSql = sql;
            return {
                11: { id: 11, proxy_id: 777 },
                21: { id: 21, proxy_id: null },
                22: { id: 22, proxy_id: 888 },
            };
        };

        try {
            await Proxy.reloadProxy();
        } finally {
            R.getAssoc = originalGetAssoc;
            UptimeKumaServer.instance = null;
        }

        assert.match(capturedSql, /FROM monitor/);

        // Default tenant bucket — unchanged behavior.
        assert.strictEqual(fakeServer.monitorListByTenant[1][11].proxy_id, 777);
        assert.strictEqual(fakeServer.monitorListByTenant[1][12].proxy_id, null);

        // Non-default tenant bucket — stale before KUM-209, correct now.
        assert.strictEqual(fakeServer.monitorListByTenant[2][21].proxy_id, null);
        assert.strictEqual(fakeServer.monitorListByTenant[2][22].proxy_id, 888);
    });

});
