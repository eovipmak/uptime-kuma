const { R } = require("redbean-node");
const { log } = require("../../src/util");
const Database = require("../database");
const { Settings } = require("../settings");
const dayjs = require("dayjs");

const DEFAULT_KEEP_PERIOD = 365;

/**
 * Clears old data from the heartbeat table and the stat tables of the database.
 *
 * G5.22 (kanban task-22): retention deletes are tenant-scoped — for each
 * active tenant, rows are deleted via a `monitor_id IN (SELECT id FROM monitor
 * WHERE tenant_id = ?)` anchor, because heartbeat/stat_* carry no tenant_id
 * column of their own (ADR-0002 — FK-anchored to monitor). When the `tenant`
 * table has no active row yet (legacy single-tenant install), the original
 * unscoped deletes run instead.
 * @returns {Promise<void>} A promise that resolves when the data has been cleared.
 */
const clearOldData = async () => {
    await Database.clearHeartbeatData();
    let period = await Settings.get("keepDataPeriodDays");

    // Set Default Period
    if (period == null) {
        await Settings.set("keepDataPeriodDays", DEFAULT_KEEP_PERIOD, "general");
        period = DEFAULT_KEEP_PERIOD;
    }

    // Try parse setting
    let parsedPeriod;
    try {
        parsedPeriod = parseInt(period);
    } catch (_) {
        log.warn("clearOldData", "Failed to parse setting, resetting to default..");
        await Settings.set("keepDataPeriodDays", DEFAULT_KEEP_PERIOD, "general");
        parsedPeriod = DEFAULT_KEEP_PERIOD;
    }

    if (parsedPeriod < 1) {
        log.info(
            "clearOldData",
            `Data deletion has been disabled as period is less than 1. Period is ${parsedPeriod} days.`
        );
    } else {
        log.debug("clearOldData", `Clearing Data older than ${parsedPeriod} days...`);
        const sqlHourOffset = Database.sqlHourOffset();
        let timestamp = dayjs().subtract(parsedPeriod, "day").utc().startOf("day").unix();

        try {
            // The tenant registry itself is global by definition.
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- iterating tenants IS the scoping mechanism here
            const tenants = await R.findAll("tenant", " status = 'active' ");

            if (tenants.length === 0) {
                // Legacy single-tenant fallback: no tenants seeded, keep the
                // original unscoped behavior.
                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- legacy single-tenant path (no tenant rows exist to scope by)
                await R.exec("DELETE FROM heartbeat WHERE time < " + sqlHourOffset, [parsedPeriod * -24]);

                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- legacy single-tenant path (no tenant rows exist to scope by)
                await R.exec("DELETE FROM stat_daily WHERE timestamp < ? ", [timestamp]);
            } else {
                for (const tenant of tenants) {
                    // Heartbeat
                    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- retention delete anchored via IN-subquery on monitor.tenant_id; heartbeat has no tenant_id column (ADR-0002)
                    await R.exec(
                        "DELETE FROM heartbeat WHERE time < "
                        + sqlHourOffset
                        + " AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                        [parsedPeriod * -24, tenant.id]
                    );

                    // Aggregated stats are anchored to the same monitors.
                    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- retention delete anchored via IN-subquery on monitor.tenant_id; stat tables have no tenant_id column (ADR-0002)
                    await R.exec(
                        "DELETE FROM stat_daily WHERE timestamp < ? AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                        [timestamp, tenant.id]
                    );
                    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- retention delete anchored via IN-subquery on monitor.tenant_id; stat tables have no tenant_id column (ADR-0002)
                    await R.exec(
                        "DELETE FROM stat_minutely WHERE timestamp < ? AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                        [timestamp, tenant.id]
                    );
                    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- retention delete anchored via IN-subquery on monitor.tenant_id; stat tables have no tenant_id column (ADR-0002)
                    await R.exec(
                        "DELETE FROM stat_hourly WHERE timestamp < ? AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                        [timestamp, tenant.id]
                    );
                }
            }

            if (Database.dbConfig.type === "sqlite") {
                await R.exec("PRAGMA optimize;");
            }
        } catch (e) {
            log.error("clearOldData", `Failed to clear old data: ${e.message}`);
        }
    }

    log.debug("clearOldData", "Data cleared.");
};

module.exports = {
    clearOldData,
};
