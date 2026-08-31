const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { SNMPMonitorType } = require("../../server/monitor-types/snmp");
const { UP } = require("../../src/util");

describe("SNMPMonitorType", () => {
    test(
        "check() sets heartbeat to UP when SNMP agent responds",
        {
            skip: !!process.env.CI,
        },
        async () => {
            const monitor = {
                type: "snmp",
                hostname: "127.0.0.1",
                port: 161,
                snmpVersion: "2c",
                radiusPassword: "public",
                snmpOid: "1.3.6.1.2.1.1.1.0",
                timeout: 5,
                maxretries: 1,
                jsonPath: "$",
                jsonPathOperator: "!=",
                expectedValue: "",
            };

            const snmpMonitor = new SNMPMonitorType();
            const heartbeat = {};

            await snmpMonitor.check(monitor, heartbeat);

            assert.strictEqual(heartbeat.status, UP);
            assert.match(heartbeat.msg, /JSON query passes/);
        }
    );

    test(
        "check() throws when SNMP agent does not respond",
        {
            skip: !!process.env.CI,
        },
        async () => {
            const monitor = {
                type: "snmp",
                hostname: "127.0.0.1",
                port: 65530, // Assuming no SNMP agent is running here
                snmpVersion: "2c",
                radiusPassword: "public",
                snmpOid: "1.3.6.1.2.1.1.1.0",
                timeout: 1,
                maxretries: 1,
            };

            const snmpMonitor = new SNMPMonitorType();
            const heartbeat = {};

            await assert.rejects(() => snmpMonitor.check(monitor, heartbeat), /timeout|RequestTimedOutError/i);
        }
    );

    test("check() uses SNMPv3 noAuthNoPriv session when version is 3", async () => {
        const originalCreateV3Session = require("net-snmp").createV3Session;
        const originalCreateSession = require("net-snmp").createSession;

        let createV3Called = false;
        let createSessionCalled = false;
        let receivedOptions = null;

        // Stub createV3Session
        require("net-snmp").createV3Session = function (_host, _username, options) {
            createV3Called = true;
            receivedOptions = options;

            return {
                on: () => {},
                close: () => {},
                // Stop execution after session creation to avoid real network I/O.
                get: (_oids, cb) => cb(new Error("stop test here")),
            };
        };

        // Stub createSession
        require("net-snmp").createSession = function () {
            createSessionCalled = true;
            return {};
        };

        const monitor = {
            type: "snmp",
            hostname: "127.0.0.1",
            port: 161,
            timeout: 5,
            maxretries: 1,
            snmpVersion: "3",
            snmp_v3_username: "testuser",
            snmpOid: "1.3.6.1.2.1.1.1.0",
        };

        const snmpMonitor = new SNMPMonitorType();
        const heartbeat = {};

        await assert.rejects(() => snmpMonitor.check(monitor, heartbeat), /stop test here/);

        // Assertions
        assert.strictEqual(createV3Called, true);
        assert.strictEqual(createSessionCalled, false);
        assert.strictEqual(receivedOptions.securityLevel, require("net-snmp").SecurityLevel.noAuthNoPriv);

        // Restore originals
        require("net-snmp").createV3Session = originalCreateV3Session;
        require("net-snmp").createSession = originalCreateSession;
    });
});
