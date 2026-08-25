/**
 * G2 task-12 — Tenant-membership watchdog (force-logout on removal)
 *
 * Plan requirement: "Xử lý edge case: user bị xóa khỏi tenant khi đang online
 * → force logout". While a user's socket session is active, an administrator
 * may remove their `tenant_user` membership row; this job periodically
 * re-validates every authenticated socket against `tenant_user` and
 * force-logs-out sessions whose membership is gone.
 *
 * On revocation each affected socket first receives `"forceLogoutTenant"`
 * with `{ tenantId }` (i18n key `forceLogoutTenant`, rendered by the client
 * in G7) and is then disconnected together with any sibling sockets of the
 * same user in the same tenant via
 * UptimeKumaServer.disconnectAllSocketClientsForTenant(). Sessions of that
 * user in OTHER tenants stay alive.
 *
 * Race tolerance (G2.12 reviewer note a): a single membership miss is NOT
 * enough to disconnect — the tick flags the socket and only a second
 * consecutive miss triggers the force logout. A transient query miss during
 * an in-flight switch/replication therefore cannot disconnect valid users,
 * nor can an attacker DoS the endpoint into logging people out.
 *
 * Interval configuration (env only, DB-driven config is a later ops pass):
 *   UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS — milliseconds between ticks,
 *   default 60000 (1 minute). Invalid or non-positive values fall back to
 *   the default.
 *
 * Lifecycle: started by UptimeKumaServer.initAfterDatabaseReady(), stopped by
 * UptimeKumaServer.stop(). Starting twice is a no-op returning the existing
 * token; stopping is always safe. The timer is unref'd so it never keeps the
 * process alive on its own.
 */
const { R } = require("redbean-node");
const { log } = require("../../src/util");

/** Default tick interval: 60 seconds. */
const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * Module-level timer handle. The job is a singleton per process: starting
 * while already running returns the existing token instead of stacking a
 * second interval.
 * @type {NodeJS.Timeout|null}
 */
let timer = null;

/**
 * Monotonic generation counter so every start() yields a distinguishable
 * token even when two starts happen within the same millisecond.
 * @type {number}
 */
let generation = 0;

/**
 * Token describing the currently running job (returned by start()).
 * @type {{ generation: number, intervalMs: number, startedAt: string }|null}
 */
let currentToken = null;

/**
 * Re-entrancy guard: a slow tick (DB latency) must never overlap the next
 * scheduled tick.
 * @type {boolean}
 */
let ticking = false;

/**
 * Sockets flagged with a missing membership on their last tick, keyed by
 * socket.id. Only sockets flagged here AND still missing membership on the
 * next tick get force-logged-out (two-strike confirmation).
 * @type {Map<string, number>}
 */
const suspectedSockets = new Map();

/**
 * Resolve the tick interval from the environment.
 * @returns {number} Interval in milliseconds (always a positive integer)
 */
function getIntervalMs() {
    const parsed = parseInt(process.env.UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS);
    if (!isNaN(parsed) && parsed > 0) {
        return parsed;
    }
    return DEFAULT_INTERVAL_MS;
}

/**
 * Check whether the given user currently has a row in `tenant_user` for the
 * given tenant (the authoritative membership source, G1 task-04).
 * @param {number} tenantId Numeric tenant id (socket.tenantID contract, G2.11)
 * @param {number} userID Numeric user id (socket.userID contract, G2.09)
 * @returns {Promise<boolean>} True when a membership row exists
 */
async function hasMembership(tenantId, userID) {
    const rows = await R.getAll(
        "SELECT 1 FROM tenant_user WHERE tenant_id = ? AND user_id = ? LIMIT 1",
        [ tenantId, userID ]
    );
    return rows.length > 0;
}

/**
 * Run exactly one membership-check pass over all connected sockets.
 * Exported as a synchronous test hook so suites can drive the logic
 * deterministically without waiting for wall-clock ticks.
 *
 * Behaviour per authenticated socket (userID + tenantID both set):
 * - member            → cleared from the suspect list, untouched;
 * - first miss        → flagged only, left connected until the next pass;
 * - second miss       → "forceLogoutTenant" emit followed by a disconnect of
 * every sibling socket of that user within the tenant;
 * - database error    → socket skipped entirely (fail-open: a storage outage
 * must not mass-disconnect valid users).
 * @param {UptimeKumaServer} server Server instance providing io + disconnectAllSocketClientsForTenant()
 * @returns {Promise<{checked: number, flagged: number, revoked: number}>} Tick statistics
 */
async function runOnce(server) {
    const stats = {
        checked: 0,
        flagged: 0,
        revoked: 0,
    };

    if (!server || !server.io || !server.io.sockets || !server.io.sockets.sockets) {
        return stats;
    }

    // Deduplicate membership queries when several sockets share the same
    // (tenant, user) pair within this tick.
    const membershipCache = new Map();

    /** Socket ids examined (authenticated) during this pass. */
    const examined = new Set();

    // SNAPSHOT the socket list before iterating: revoking a socket removes
    // it (and its siblings) from the live map mid-loop, which would silently
    // skip not-yet-visited sockets and under-count revocations.
    for (const socket of [ ...server.io.sockets.sockets.values() ]) {
        try {
            // Skip handshaking / anonymous sockets: there is nothing to revoke.
            if (socket.userID == null || socket.tenantID == null) {
                continue;
            }

            stats.checked++;
            examined.add(socket.id);

            const pairKey = `${socket.tenantID}:${socket.userID}`;
            let isMember = membershipCache.get(pairKey);

            if (isMember === undefined) {
                try {
                    isMember = await hasMembership(socket.tenantID, socket.userID);
                } catch (e) {
                    // Fail-open: skip this socket this tick, keep any prior
                    // suspicion untouched. Never disconnect on uncertainty.
                    log.error("check-tenant-membership", `Membership lookup failed for user ${socket.userID} in tenant ${socket.tenantID}: ${e.message}`);
                    continue;
                }
                membershipCache.set(pairKey, isMember);
            }

            if (isMember) {
                suspectedSockets.delete(socket.id);
                continue;
            }

            if (!suspectedSockets.has(socket.id)) {
                // First consecutive miss: tolerate in-flight switches / races
                // (reviewer note a). Confirm before cutting the session.
                suspectedSockets.set(socket.id, Date.now());
                stats.flagged++;
                log.debug("check-tenant-membership", `Membership missing for user ${socket.userID} in tenant ${socket.tenantID}; flagged for confirmation`);
                continue;
            }

            // Confirmed revoked on two consecutive passes → force logout.
            stats.revoked++;
            suspectedSockets.delete(socket.id);
            log.info("check-tenant-membership", `Force-logout: user ${socket.userID} lost membership of tenant ${socket.tenantID}`);

            // Message EVERY session of this (tenant, user) pair BEFORE any
            // disconnect closes transports — otherwise the sibling sockets
            // cut by disconnectAllSocketClientsForTenant below would vanish
            // without ever learning why.
            for (const target of [ ...server.io.sockets.sockets.values() ]) {
                if (target.tenantID === socket.tenantID && target.userID === socket.userID) {
                    try {
                        target.emit("forceLogoutTenant", { tenantId: socket.tenantID });
                    } catch (e) {}
                }
            }

            // No currentSocketID exclusion: every sibling socket of this user
            // inside the same tenant goes down together, other tenants survive.
            server.disconnectAllSocketClientsForTenant(socket.tenantID, socket.userID);
        } catch (e) {
            log.error("check-tenant-membership", `Error checking socket ${socket && socket.id}: ${e.message}`);
        }
    }

    // Prune suspects whose session ended meanwhile (disconnected or logged
    // out): a fresh login gets a clean two-strike cycle again.
    for (const socketID of suspectedSockets.keys()) {
        if (!examined.has(socketID)) {
            suspectedSockets.delete(socketID);
        }
    }

    return stats;
}

/**
 * Start the periodic membership check. Idempotent: when a job is already
 * running, the existing token is returned and no additional timer created.
 * @param {UptimeKumaServer} server Server instance (captured for every tick)
 * @returns {{ generation: number, intervalMs: number, startedAt: string }} Opaque job token
 */
function startTenantMembershipCheckJob(server) {
    if (timer) {
        return currentToken;
    }

    const intervalMs = getIntervalMs();
    timer = setInterval(() => {
        if (ticking) {
            return;
        }
        ticking = true;
        runOnce(server)
            .catch((e) => log.error("check-tenant-membership", `Tick failed: ${e.message}`))
            .finally(() => {
                ticking = false;
            });
    }, intervalMs);

    // Never hold the process open just for this timer (clean shutdown).
    if (typeof timer.unref === "function") {
        timer.unref();
    }

    currentToken = {
        generation: ++generation,
        intervalMs,
        startedAt: new Date().toISOString(),
    };
    log.info("check-tenant-membership", `Tenant membership check started (interval ${intervalMs}ms)`);
    return currentToken;
}

/**
 * Stop the membership check and clear all transient state (flags, guards).
 * Safe to call even when the job was never started; the token parameter is
 * accepted for symmetry with start() and may be null.
 * @param {{ generation: number, intervalMs: number, startedAt: string }|null} token Token returned by startTenantMembershipCheckJob()
 * @returns {void}
 */
function stopTenantMembershipCheckJob(token) {
    if (timer) {
        clearInterval(timer);
    }
    timer = null;
    currentToken = null;
    ticking = false;
    suspectedSockets.clear();
}

module.exports = {
    startTenantMembershipCheckJob,
    stopTenantMembershipCheckJob,
    runOnce,
};
