const { R } = require("redbean-node");
const { log } = require("../../src/util");
const Database = require("../database");
const { Settings } = require("../settings");
const dayjs = require("dayjs");

// Keep in sync with DEFAULT_TENANT_SLUG in server/repository/tenant-repo.js.
// Duplicated as a literal instead of imported so the job does not pull the
// repository import graph (same rationale as the repo wrapper itself).
const DEFAULT_TENANT_SLUG = "default";

const DEFAULT_KEEP_PERIOD = 365;

/**
 * Per-plan heartbeat/stat retention in days (G5.23), keyed by `tenant.plan`.
 * Hardcoded defaults until G8 (Billing) owns plan management; an unknown or
 * null plan falls back to DEFAULT_KEEP_PERIOD.
 * @type {Record<string, number>}
 */
const RETENTION_DAYS_BY_PLAN = {
    free: 7,
    pro: 90,
    business: 365,
    enterprise: 730,
};

/**
 * Retention period for a tenant plan (G5.23).
 * @param {string|null} plan Value of tenant.plan (null/unknown → default)
 * @returns {number} Retention period in days
 */
function getRetentionDaysForPlan(plan) {
    if (!plan) {
        return DEFAULT_KEEP_PERIOD;
    }
    return RETENTION_DAYS_BY_PLAN[String(plan).toLowerCase()] ?? DEFAULT_KEEP_PERIOD;
}

/**
 * Read the legacy global retention period from Settings (pre-G5.23 behavior),
 * writing the default back when unset/unparsable.
 * @returns {Promise<number>} Parsed period in days (may be < 1 = disabled)
 */
async function resolveLegacyKeepPeriod() {
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

    return parsedPeriod;
}

/**
 * Legacy single-tenant cleanup: one global retention period from Settings.
 * Kept verbatim (minus the shared Database.clearHeartbeatData sweep) for the
 * no-tenant-rows fallback so pre-multi-tenant installs behave exactly as before.
 * @returns {Promise<void>}
 */
async function clearLegacyGlobalData() {
    const parsedPeriod = await resolveLegacyKeepPeriod();

    if (parsedPeriod < 1) {
        log.info(
            "clearOldData",
            `Data deletion has been disabled as period is less than 1. Period is ${parsedPeriod} days.`
        );
        return;
    }

    log.debug("clearOldData", `Clearing Data older than ${parsedPeriod} days...`);
    const sqlHourOffset = Database.sqlHourOffset();

    try {
        // Heartbeat
        await R.exec("DELETE FROM heartbeat WHERE time < " + sqlHourOffset, [parsedPeriod * -24]);

        let timestamp = dayjs().subtract(parsedPeriod, "day").utc().startOf("day").unix();

        // stat_daily
        await R.exec("DELETE FROM stat_daily WHERE timestamp < ? ", [timestamp]);
    } catch (e) {
        log.error("clearOldData", `Failed to clear old data: ${e.message}`);
    }
}

/**
 * Per-tenant cleanup (G5.23): each tenant's heartbeat/stat rows are pruned
 * against its own plan's retention period. Heartbeat and stat rows carry no
 * tenant_id column (G1 design — they inherit tenancy through their monitor
 * anchor), so deletion scopes through a monitor subquery. The default tenant
 * keeps the legacy Settings-driven period: it absorbs every upgraded
 * single-tenant install, and silently shrinking their history to the free
 * plan's window would be a destructive regression.
 * @param {object[]} tenants All tenant rows
 * @returns {Promise<void>}
 */
async function clearPerTenantData(tenants) {
    const sqlHourOffset = Database.sqlHourOffset();
    let sawDisabledDefaultTenant = false;

    for (const tenant of tenants) {
        let retentionDays;

        if (tenant.slug === DEFAULT_TENANT_SLUG) {
            const legacyPeriod = await resolveLegacyKeepPeriod();
            if (legacyPeriod < 1) {
                sawDisabledDefaultTenant = true;
                continue;
            }
            retentionDays = legacyPeriod;
        } else {
            retentionDays = getRetentionDaysForPlan(tenant.plan);
        }

        log.debug(
            "clearOldData",
            `Tenant ${tenant.id} (${tenant.slug ?? "?"}): clearing data older than ${retentionDays} days (plan: ${tenant.plan ?? "none"})`
        );

        try {
            // Heartbeat rows anchor to their monitor; the subquery carries the
            // tenant scope (the wrapper's execForTenant cannot express this
            // multi-table DELETE, hence direct R.exec with the injected filter).
            await R.exec(
                "DELETE FROM heartbeat WHERE time < " + sqlHourOffset +
                " AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                [retentionDays * -24, tenant.id]
            );

            // stat_daily buckets start at UTC day boundaries; hourly/minutely
            // use raw epoch-second cutoffs.
            const dailyTimestamp = dayjs().subtract(retentionDays, "day").utc().startOf("day").unix();
            const cutoffTimestamp = dayjs().utc().subtract(retentionDays, "day").unix();

            await R.exec(
                "DELETE FROM stat_daily WHERE timestamp < ? AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                [dailyTimestamp, tenant.id]
            );
            await R.exec(
                "DELETE FROM stat_hourly WHERE timestamp < ? AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                [cutoffTimestamp, tenant.id]
            );
            await R.exec(
                "DELETE FROM stat_minutely WHERE timestamp < ? AND monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)",
                [cutoffTimestamp, tenant.id]
            );
        } catch (e) {
            log.error("clearOldData", `Failed to clear old data for tenant ${tenant.id}: ${e.message}`);
        }
    }

    if (sawDisabledDefaultTenant) {
        log.info(
            "clearOldData",
            "Data deletion has been disabled as period is less than 1 (default tenant)."
        );
    }
}

/**
 * Clears old data from the heartbeat table and the stat tables of the database.
 * Multi-tenant behavior (G5.23): when tenant rows exist, every tenant is
 * pruned against its own plan's retention period; with no tenant rows at all,
 * falls back to the original global Settings-driven cleanup.
 * @returns {Promise<void>} A promise that resolves when the data has been cleared.
 */
const clearOldData = async () => {
    await Database.clearHeartbeatData();

    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- tenant registry enumeration drives per-tenant retention (partition discovery)
    const tenants = await R.find("tenant", " status = 'active' ");

    if (tenants.length > 0) {
        await clearPerTenantData(tenants);
    } else {
        await clearLegacyGlobalData();
    }

    if (Database.dbConfig.type === "sqlite") {
        await R.exec("PRAGMA optimize;");
    }

    log.debug("clearOldData", "Data cleared.");
};

module.exports = {
    clearOldData,
    getRetentionDaysForPlan,
};
