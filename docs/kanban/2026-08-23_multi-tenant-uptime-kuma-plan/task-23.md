# Task G5.23 — Quota, Rate Limiting, Prometheus, Retention & Multi-Tenant Engine Tests

**Phase:** G5 — Monitoring Engine Multi-Tenant
**Status:** todo
**Reviewer:** Backend engine lead / Security lead / Uptime Kuma maintainer (G5 closing signoff)

## Objective

Deliver the remaining G5 engine hardening: per-tenant quota enforcement (max monitors, min check interval), Prometheus `tenant_id` labeling, per-tenant heartbeat retention policy (preparing for G8 billing tiers), noisy-neighbor fairness (staggered per-tenant tick loops), and the G5 acceptance test suite that validates the full engine pipeline end-to-end with multiple tenants.

This task **closes Phase G5**.

## Prerequisites/dependencies

- **Task G5.21** reviewed and approved — `monitorListByTenant`, `UptimeCalculator.listByTenant`, `startMonitor(tenantId, ...)`, `startMonitors()` tenant-iterating.
- **Task G5.22** reviewed and approved — heartbeat write path emits to `userRoom(tenantId, userID)`, notification dispatch carries `tenantId`, `clearOldData` iterates tenants.
- **Phase G4 (17/18/19/20)** approved — wrapper, IDOR test suite, cache-key namespace.
- **Phase G3 (13/14/15/16)** approved — RBAC matrix.
- **Phase G2 (09/10/11/12)** approved — tenant-context provider, socket rooms.
- **Phase G1 (04/05/06/08)** approved — `tenant` table, `tenant_id` columns, demo seed (3 tenants).
- **Can run in parallel with `task-22`** — `task-22` touches `beat()` closure, `sendNotification`, `clearOldData`; `task-23` touches `startMonitor` (quota gate), `prometheus.js`, `startMonitors` (fairness), and tests. The file sets have minimal overlap: `task-22` touches `monitor.js`'s `beat()` and `sendNotification`; `task-23` touches `monitor.js`'s `start()` (quota check) and `prometheus.js`. Coordination point: both tasks modify `monitor.js`; the merge order is `task-21` → `task-22` → `task-23` (or `task-21` → rebase both on top of each other).
- **If `task-21` is incomplete:** stop, report the blocker, do not write quota/metrics against a moving engine contract.

## Owner / recommended agent profile

**Backend test engineer (security + performance)** — same profile as `task-16` (RBAC tests) and `task-20` (IDOR tests); fluent with the Node.js test runner, Supertest, the socket.io harness from `task-12`, and Prometheus client library (`prom-client`). Must understand quota enforcement patterns and retention policy implementation.

## Exact files and artifacts to create or modify

1. **Create** `test/backend-test/test-tenant-engine.js` — the G5 multi-tenant engine acceptance suite (the deliverable).
2. **Modify** `server/server.js` — `startMonitor(tenantId, userID, monitorID)` adds a quota gate before starting.
3. **Modify** `server/prometheus.js` — add `tenant_id` label to all monitor metrics.
4. **Modify** `server/model/monitor.js` — `Monitor.start(io)`'s `beat()` closure adds tenant-aware Prometheus update.
5. **Modify** `server/jobs/clear-old-data.js` — per-tenant retention policy (optionally reading from `tenant.plan` column).
6. **Modify** `server/server.js` — `startMonitors()` adds per-tenant staggering with configurable concurrency.

## Concrete implementation steps

1. **Re-read** `task-21.md` (engine contracts), `task-22.md` (heartbeat/notification contracts), `task-17.md` (wrapper), `task-16.md` (RBAC test patterns), `task-20.md` (IDOR test patterns).

2. **Quota enforcement in `startMonitor`:**
   ```js
   async function startMonitor(tenantId, userID, monitorID) {
       // ... existing checkOwner, execForTenant, findOneForTenant ...
       
       // QUOTA GATE: max monitors per tenant
       const tenantMonitors = await findForTenant("monitor", "active = 1", [], tenantId, "");
       const maxMonitors = await getTenantQuota(tenantId, "maxMonitors"); // default 100 for Free
       if (tenantMonitors.length >= maxMonitors) {
           throw new TranslatableError("monitor.quotaExceeded", { max: maxMonitors });
       }
       
       // QUOTA GATE: min check interval
       const minInterval = await getTenantQuota(tenantId, "minCheckInterval"); // default 60s for Free
       if (monitor.interval < minInterval) {
           throw new TranslatableError("monitor.intervalTooLow", { min: minInterval });
       }
       
       // ... rest of startMonitor ...
   }
   ```
   The `getTenantQuota(tenantId, key)` function reads from `tenant.quota` JSON column (or a dedicated `tenant_quota` table if G1 `task-04` didn't include it — in that case, use hardcoded defaults keyed by plan: `{ free: { maxMonitors: 100, minCheckInterval: 60 }, pro: { maxMonitors: 500, minCheckInterval: 30 } }`). The hardcoded defaults are sufficient until G8 (Billing) replaces them with database-driven quotas.

3. **Prometheus `tenant_id` label:**
   In `server/prometheus.js`:
   - Add `tenant_id` to the label set of every gauge: `monitor_status`, `monitor_response_time`, `monitor_response_time_seconds`, `monitor_uptime_ratio`, `monitor_cert_days_remaining`, `monitor_cert_is_valid`.
   - `static async init()` — the label list changes from `['monitor_id', 'monitor_name', 'monitor_type', 'monitor_url', 'monitor_hostname', 'monitor_port', ...tags]` to `['tenant_id', 'monitor_id', 'monitor_name', 'monitor_type', 'monitor_url', 'monitor_hostname', 'monitor_port', ...tags]`.
   - `update(heartbeat, tlsInfo, uptime)` — the method signature extends to `update(tenantId, heartbeat, tlsInfo, uptime)`; the `tenantId` is set as a label value.
   - `remove()` — the method extends to `remove(tenantId, monitorID)` to remove the specific `(tenantId, monitorID)` label combination.
   - In `Monitor.start()` → `beat()`: the `getPrometheus()` instance is created per-monitor; its `update` call now passes `tenantId`.

4. **Per-tenant heartbeat retention in `clearOldData`:**
   The retention period is read from `tenant.plan` (or `tenant.heartbeat_retention_days` if G1 added it). Default: `{ free: 7, pro: 90, business: 365, enterprise: 730 }` days.
   ```js
   const retentionDays = getRetentionDaysForPlan(tenant.plan); // default 365 if plan is null
   const cutoff = dayjs.utc().subtract(retentionDays, 'day').toISOString();
   ```
   The `stat_daily` / `stat_hourly` / `stat_minutely` tables use the same retention period.

5. **Noisy-neighbor fairness in `startMonitors`:**
   ```js
   async function startMonitors() {
       const tenants = await R.find("tenant", " status = 'active' ");
       const MAX_CONCURRENT_TENANTS = 5; // configurable via env var
       
       // Stagger tenant startup
       for (let i = 0; i < tenants.length; i += MAX_CONCURRENT_TENANTS) {
           const batch = tenants.slice(i, i + MAX_CONCURRENT_TENANTS);
           await Promise.all(batch.map(async (tenant) => {
               server.monitorListByTenant[tenant.id] = {};
               const monitors = await findForTenant("monitor", " active = 1 ", [], tenant.id, "ORDER BY weight DESC");
               for (const monitor of monitors) {
                   server.monitorListByTenant[tenant.id][monitor.id] = monitor;
               }
               for (const monitor of monitors) {
                   await monitor.start(io);
                   await sleep(getRandomInt(300, 1000));
               }
           }));
           if (i + MAX_CONCURRENT_TENANTS < tenants.length) {
               await sleep(2000); // inter-batch delay
           }
       }
   }
   ```
   The `MAX_CONCURRENT_TENANTS` is configurable via `Settings.get("maxConcurrentTenantStartup")` or env var `UPTIME_KUMA_MAX_CONCURRENT_TENANT_STARTUP=5`.

6. **`test/backend-test/test-tenant-engine.js`** — the G5 acceptance suite:
   - **`before`** — reuse the in-process Socket.IO server harness from `task-12` (or `task-16`/`task-20`). Seed via G1 `task-07`'s demo seed (Acme, XYZ, 123).
   - **Setup helper** — `loginAsTenant(tenantSlug)` returns `{ socket, token, tenantId, userId }`.
   - **Monitor lifecycle test** — for tenant A:
     - Add a monitor → assert `startMonitor` succeeds → assert `monitorListByTenant[tenantA.id]` has the monitor.
     - Wait for heartbeat → assert `io.to(userRoom(tenantA.id, userId))` received `"heartbeat"` event.
     - Pause monitor → assert `monitorListByTenant[tenantA.id][monitorID].active === 0`.
     - Resume monitor → assert heartbeat resumes.
     - Delete monitor → assert `monitorListByTenant[tenantA.id][monitorID]` is undefined.
   - **Cross-tenant heartbeat isolation** — login as tenant A, create a monitor, wait for heartbeat. Login as tenant B — assert tenant B's socket does NOT receive tenant A's heartbeat event.
   - **Quota enforcement test** — login as tenant A (Free plan, max 100 monitors). Add 100 monitors → add 101st → assert `TranslatableError("monitor.quotaExceeded")`.
   - **Min interval enforcement test** — login as tenant A (Free plan, min 60s). Try to create a monitor with `interval: 30` → assert `TranslatableError("monitor.intervalTooLow")`.
   - **Prometheus label test** — after creating a monitor and receiving a heartbeat, query `GET /metrics` → assert the `monitor_status` metric has `tenant_id="<tenantA.id>"` label.
   - **Notification cross-tenant test** — login as tenant A, create a notification. Create a monitor for tenant A with that notification. Login as tenant B — assert tenant B's `getNotificationList` does not include tenant A's notification.
   - **`clearOldData` per-tenant test** — create heartbeats for tenant A and tenant B with different ages. Run `clearOldData`. Assert tenant A's old heartbeats are deleted; tenant B's matching-age heartbeats are NOT deleted (if retention differs).
   - **Shutdown/restart test** — call `shutdownFunction`, then `startMonitors`. Assert all tenants' monitors restart and heartbeats resume.
   - **Default-tenant regression** — login as default-tenant admin (single-tenant legacy). All existing tests from `test-backend` must pass.

7. **JSDoc** on every new method.

## Interfaces/contracts and integration points

- **Upstream consumers (G5):** `task-21`'s partitioned maps, `task-22`'s heartbeat/notification paths.
- **Upstream consumers (G4):** `findForTenant`, `execForTenant` from `task-17`.
- **Upstream consumers (G2):** `userRoom(tenantId, userID)` from `task-11`.
- **Upstream consumers (G1):** demo seed (3 tenants) from `task-07`.
- **Downstream consumers (later phases):**
  - G6 (Status page) — the Prometheus `tenant_id` label feeds into per-tenant status page metrics.
  - G8 (Billing) — `getTenantQuota(tenantId, key)` is the hook point; G8 replaces the hardcoded defaults with database-driven quotas from Stripe/Paddle webhooks.
  - G9 (Security) — the quota enforcement is a DoS protection surface; G9 adds rate limiting on top.
  - G10 (DevOps) — `MAX_CONCURRENT_TENANTS` env var is wired into the Golden Image's Docker Compose / Helm chart.
  - G11 (Testing) — the `test-tenant-engine.js` suite is extended with load tests (k6).
- **Behavioral parity contract:**
  - Existing tests pass — default-tenant admin's quota is unlimited (or at least 1000, matching the legacy behavior).
  - Prometheus metrics gain a `tenant_id` label but the metric names and other labels are unchanged (backward compat for existing dashboards).
  - The `clearOldData` per-tenant iteration is backward-compatible: if `tenant` table is empty, fall back to the original behavior.

## Acceptance criteria

- [ ] `startMonitor` enforces max-monitors-per-tenant quota (hardcoded defaults by plan until G8).
- [ ] `startMonitor` enforces min-check-interval quota (hardcoded defaults by plan until G8).
- [ ] All Prometheus gauges (`monitor_status`, `monitor_response_time`, `monitor_uptime_ratio`, `monitor_cert_days_remaining`, `monitor_cert_is_valid`) have `tenant_id` label.
- [ ] `Prometheus.update` accepts `tenantId` and sets it as a label value.
- [ ] `clearOldData` uses per-tenant retention period (hardcoded defaults by plan until G8).
- [ ] `startMonitors` staggers tenant startup with configurable `MAX_CONCURRENT_TENANTS`.
- [ ] `test/backend-test/test-tenant-engine.js` exists and covers: monitor lifecycle, cross-tenant heartbeat isolation, quota enforcement, Prometheus labels, notification cross-tenant, `clearOldData` per-tenant, shutdown/restart, default-tenant regression.
- [ ] `npm run test-backend` passes with the new engine test suite and zero regression.
- [ ] `npm run lint` passes on all modified files.
- [ ] No new files besides `test/backend-test/test-tenant-engine.js`.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Confirm quota gate in startMonitor
grep -A 10 "async function startMonitor" server/server.js | grep -E "quota|maxMonitors|minInterval"

# 2. Confirm Prometheus tenant_id label
grep "tenant_id" server/prometheus.js

# 3. Confirm clearOldData per-tenant retention
grep -A 10 "async function clearOldData" server/jobs/clear-old-data.js | grep -E "retention|plan"

# 4. Confirm startMonitors batching
grep -A 20 "async function startMonitors" server/server.js | grep -E "MAX_CONCURRENT|batch|Promise.all"

# 5. Run engine tests
node --test test/backend-test/test-tenant-engine.js 2>&1 | tail -40

# 6. Lint
npx eslint server/server.js server/prometheus.js server/model/monitor.js server/jobs/clear-old-data.js test/backend-test/test-tenant-engine.js

# 7. Full regression
npm run test-backend 2>&1 | tail -40

# 8. Prometheus endpoint smoke test
#    (manual: start server, curl http://localhost:3001/metrics | grep tenant_id)
```

## Reviewer

Backend engine lead / Security lead / Uptime Kuma maintainer. Must verify that quota enforcement is correct, Prometheus labels are backward-compatible, retention policy is per-tenant, and the test suite covers all G5 Definition of Done items.

## Explicit out-of-scope items

- **Database-driven quota (G8)** — hardcoded defaults by plan are temporary; G8 replaces them with Stripe/Paddle-driven quotas.
- **Billing-tier plan management** — G8 owns the plan field on `tenant`.
- **Redis-backed rate limiting** — G9/G10 own this.
- **Notification rate limit per tenant** — deferred to G9 (security hardening) or G8 (billing tier).
- **Frontend quota display** — G7 owns the UI.
- **Audit log for quota enforcement** — G9 owns audit logging.
- **Load test (k6)** — G11 owns load testing.