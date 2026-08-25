# Task G5.21 — Scheduler Tenant Partitioning (Engine Core Refactor)

**Phase:** G5 — Monitoring Engine Multi-Tenant
**Status:** todo
**Estimate:** XL (per plan template "Format output task chuẩn")
**Reviewer:** Backend engine lead / Uptime Kuma maintainer (G5 entry-point signoff)

## Objective

Refactor the monitoring engine's in-memory data structures from flat (single-tenant) maps to tenant-partitioned maps so the scheduler, heartbeat writer, and notification dispatcher each operate on their own tenant's monitors without cross-tenant leakage. This task is the **G5 contract originator** — it freezes the new data structures (`monitorListByTenant`, `maintenanceListByTenant`, `uptimeCalculatorListByTenant`) and the revised method signatures that tasks 22 and 23 consume.

The existing engine in `server/server.js` uses a flat `server.monitorList[monitorID]` map, a flat `server.maintenanceList[maintenanceID]` map, and `startMonitors()` loads ALL active monitors across all users. The G1 migration already added `tenant_id` to every tenant-owned table, and G4 wrapped every query with tenant-scoped access. The missing piece is the **runtime engine** — the in-process scheduler that loads, starts, stops, and iterates monitors.

## Prerequisites/dependencies

- **Phase G4 fully approved** (tasks 17/18/19/20):
  - `task-17` — tenant-safe query wrapper (`findOneForTenant`, `findForTenant`, `execForTenant`, `dispenseForTenant`, `TenantScopedQueryBuilder`) available.
  - `task-18` — socket-handler call sites migrated to wrapper; `socket.tenantID` guaranteed set.
  - `task-19` — model static methods (`Monitor.getPreviousHeartbeat`, `Monitor.deleteMonitor`, `Monitor.getMonitorList`, etc.) accept `tenantId`; `UptimeKumaServer.getMonitorJSONList(tenantId, userID)` signature frozen.
  - `task-20` — IDOR test suite passes; cache-key namespace adopted.
- **Phase G3 (13/14/15/16)** approved — RBAC gates the role dimension.
- **Phase G2 (09/10/11/12)** approved — `socket.tenantID` and `req.user.tenantId` are set before any business logic runs.
- **Phase G1 (04/05/06/08)** approved — `tenant_id` columns exist; FK cascade set; default tenant backfill done.
- **If any G4/G3/G2/G1 task is incomplete:** stop, report the blocker ("Waiting on G4 (17/18/19/20) signoff"), do not refactor the engine against an unverified data layer.

## Owner / recommended agent profile

**Backend engine architect** — deep understanding of the `UptimeKumaServer` class lifecycle, the `Monitor.start()` async beat loop, the `startMonitors()`/`startMonitor()`/`pauseMonitor()` orchestration in `server/server.js`, and the `UptimeCalculator` in-memory queue. Must be comfortable refactoring the scheduler's core data structures without breaking the existing single-tenant backward-compat path.

## Exact files and artifacts to create or modify

1. **Modify** `server/uptime-kuma-server.js` **(primary)**:
   - `monitorList = {}` → `monitorListByTenant = {}` (a `Map<tenantId, Map<monitorID, Monitor>>` or plain object `{ [tenantId]: { [monitorID]: monitor } }`). The old `monitorList` property is deprecated with a getter that returns `monitorListByTenant[DEFAULT_TENANT_ID]` for backward compat (single-tenant installs).
   - `maintenanceList = {}` → `maintenanceListByTenant = {}` (same shape).
   - `getMonitorJSONList(userID, monitorID)` → `getMonitorJSONList(tenantId, userID, monitorID = null)` — uses `findForTenant` from G4 wrapper.
   - `sendMonitorList(socket)` → scoped to `socket.tenantID`; retrieves from `monitorListByTenant[socket.tenantID]`.
   - `sendUpdateMonitorIntoList(socket, monitorID)` → scoped by `socket.tenantID`.
   - `sendDeleteMonitorFromList(socket, monitorID)` → scoped by `socket.tenantID`.
   - `loadMaintenanceList(userID)` → `loadMaintenanceList(tenantId, userID)` — loads from `maintenanceListByTenant[tenantId]`.
   - `getMaintenance(maintenanceID)` → `getMaintenance(tenantId, maintenanceID)` — scoped lookup.
2. **Modify** `server/server.js` **(secondary)**:
   - `startMonitors()` → iterates `tenant` table to discover all tenants, then for each tenant loads its active monitors: `const monitors = await findForTenant("monitor", "active = 1", [], tenantId, "ORDER BY weight DESC")`. Each monitor is stored in `server.monitorListByTenant[tenantId][monitor.id]`. Staggers startup across tenants (not just within tenant) to avoid thundering herd.
   - `startMonitor(userID, monitorID)` → `startMonitor(tenantId, userID, monitorID)` — uses `execForTenant("UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ?", [monitorID, userID], tenantId)` and `findOneForTenant("monitor", "id = ?", [monitorID], tenantId)`.
   - `pauseMonitor(userID, monitorID)` → `pauseMonitor(tenantId, userID, monitorID)` — same signature migration pattern.
   - `restartMonitor(userID, monitorID)` → `restartMonitor(tenantId, userID, monitorID)`.
   - `shutdownFunction(signal)` → iterates `monitorListByTenant` to stop all monitors across all tenants.
   - `afterLogin(socket, user)` → after sending `monitorList`, iterates `monitorListByTenant[socket.tenantID]` to send `heartbeatList` and `Monitor.sendStats` for each monitor.
3. **Modify** `server/uptime-calculator.js`:
   - `static list = {}` → `static listByTenant = {}` (a `{ [tenantId]: { [monitorID]: UptimeCalculator } }` map).
   - `static getUptimeCalculator(monitorID)` → `static getUptimeCalculator(tenantId, monitorID)` — looks up `listByTenant[tenantId][monitorID]`.
   - `static remove(monitorID)` → `static remove(tenantId, monitorID)`.
   - `static removeAll()` → `static removeAll()` — iterates all tenants.
   - `static removeAllForTenant(tenantId)` — new method for off-boarding a tenant.
4. **Modify** `server/model/monitor.js`:
   - `Monitor.start(io)` — the `beat()` closure now captures `this.tenant_id` (set by G1 `task-05` on the monitor row). The `UptimeCalculator.getUptimeCalculator(this.tenant_id, this.id)` call uses the new signature.
   - `Monitor.stop()` — `UptimeCalculator.remove(this.tenant_id, this.id)`.
   - `Monitor.sendStats(io, monitorID, userID)` → `Monitor.sendStats(io, tenantId, monitorID, userID)`.
   - `Monitor.sendCertInfo(io, monitorID, userID)` → `Monitor.sendCertInfo(io, tenantId, monitorID, userID)`.
   - `Monitor.sendDomainInfo(io, monitorID, userID)` → `Monitor.sendDomainInfo(io, tenantId, monitorID, userID)`.
   - `Monitor.deleteMonitor(monitorID, userID)` → `Monitor.deleteMonitor(monitorID, userID, tenantId)` — stops the monitor from `monitorListByTenant[tenantId]` before deleting.
   - `Monitor.deleteMonitorRecursively(monitorID, userID)` → `Monitor.deleteMonitorRecursively(monitorID, userID, tenantId)`.
5. **No new files** — all work is refactoring existing engine structures.

## Concrete implementation steps

1. Re-read `task-17.md` (wrapper signatures), `task-19.md` (model method signatures — `getMonitorJSONList(tenantId, userID)` already there), and `task-18.md` (socket handlers already thread `socket.tenantID`).
2. **`server/uptime-kuma-server.js` — `monitorListByTenant`:**
   - Replace `this.monitorList = {}` with `this.monitorListByTenant = {}`.
   - Add a backward-compat getter: `get monitorList() { return this.monitorListByTenant["default"] || {}; }` so any code still referencing `server.monitorList` (e.g., in `server/server.js` inline handlers) gracefully degrades for the default tenant. Add a `@deprecated` JSDoc tag.
   - Same for `maintenanceList` → `maintenanceListByTenant` with a compat getter.
3. **`server/server.js` — `startMonitors()`:**
   ```js
   async function startMonitors() {
       const tenants = await R.find("tenant", " status = 'active' ");
       for (const tenant of tenants) {
           server.monitorListByTenant[tenant.id] = {};
           const monitors = await findForTenant("monitor", " active = 1 ", [], tenant.id, "");
           for (const monitor of monitors) {
               server.monitorListByTenant[tenant.id][monitor.id] = monitor;
           }
           for (const monitor of monitors) {
               await monitor.start(io);
               await sleep(getRandomInt(300, 1000));
           }
       }
   }
   ```
   If the `tenant` table is empty (single-tenant legacy install), fall back to loading all active monitors into the default tenant bucket (backward compat). Use `R.find("monitor", " active = 1 ")` as the fallback query.
4. **`server/server.js` — `startMonitor(tenantId, userID, monitorID)`:**
   ```js
   async function startMonitor(tenantId, userID, monitorID) {
       await checkOwner(userID, monitorID);
       await execForTenant("UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ? ", [monitorID, userID], tenantId);
       const monitor = await findOneForTenant("monitor", " id = ? ", [monitorID], tenantId);
       if (monitor.id in (server.monitorListByTenant[tenantId] || {})) {
           await server.monitorListByTenant[tenantId][monitor.id].stop();
       }
       if (!server.monitorListByTenant[tenantId]) server.monitorListByTenant[tenantId] = {};
       server.monitorListByTenant[tenantId][monitor.id] = monitor;
       await monitor.start(io);
   }
   ```
5. **`server/server.js` — `pauseMonitor` / `restartMonitor`:** same signature migration to `(tenantId, userID, monitorID)`.
6. **`server/server.js` — `shutdownFunction`:** iterate `Object.values(server.monitorListByTenant).flatMap(Object.values)` to stop all monitors.
7. **`server/uptime-calculator.js` — `listByTenant`:**
   ```js
   static listByTenant = {};
   static getUptimeCalculator(tenantId, monitorID) {
       if (!this.listByTenant[tenantId]) this.listByTenant[tenantId] = {};
       if (!this.listByTenant[tenantId][monitorID]) {
           this.listByTenant[tenantId][monitorID] = new UptimeCalculator();
           this.listByTenant[tenantId][monitorID].init(monitorID);
       }
       return this.listByTenant[tenantId][monitorID];
   }
   static remove(tenantId, monitorID) {
       if (this.listByTenant[tenantId]) delete this.listByTenant[tenantId][monitorID];
   }
   static removeAllForTenant(tenantId) {
       delete this.listByTenant[tenantId];
   }
   static removeAll() {
       this.listByTenant = {};
   }
   ```
8. **`server/model/monitor.js` — `Monitor.start(io)` `beat()` closure:**
   - The monitor row already has `this.tenant_id` (from G1). Capture it in the closure: `const tenantId = this.tenant_id;`.
   - `UptimeCalculator.getUptimeCalculator(this.id)` → `UptimeCalculator.getUptimeCalculator(tenantId, this.id)`.
   - `Monitor.sendStats(io, this.id, this.user_id)` → `Monitor.sendStats(io, tenantId, this.id, this.user_id)`.
9. **`server/model/monitor.js` — `Monitor.sendStats(io, tenantId, monitorID, userID)`:**
   - Retrieves the calculator: `UptimeCalculator.getUptimeCalculator(tenantId, monitorID)`.
   - Emits to the tenant-scoped room: `io.to(userRoom(tenantId, userID)).emit(...)` (the room key from G2 `task-11`).
10. **`server/server.js` — `afterLogin`:** iterates `server.monitorListByTenant[socket.tenantID]` to emit `heartbeatList` and `sendStats` for each monitor.
11. **`server/server.js` — inline socket handlers:** update `startMonitor`, `pauseMonitor`, `restartMonitor`, `deleteMonitor` calls to pass `socket.tenantID` as the first argument. The existing `checkLogin(socket)` + G2 `checkOwner` pattern remains.
12. **Test backward compat:** `npm run test-backend` — the default-tenant admin (single-tenant install) has `tenantId = "default"` and all monitors are in `monitorListByTenant["default"]`. The compat getter ensures any code still using `server.monitorList` works.
13. **JSDoc** on every new/migrated method's `tenantId` parameter.

## Interfaces/contracts and integration points

- **Upstream consumers (G1–G4):** wrapper from `task-17`, model signatures from `task-19`, socket context from `task-11`.
- **Downstream consumers (within G5):**
  - `task-22` (heartbeat/notification tenant-aware) — consumes the partitioned `monitorListByTenant`, the new `UptimeCalculator.getUptimeCalculator(tenantId, monitorID)`, and the `Monitor.sendStats(io, tenantId, monitorID, userID)` signature.
  - `task-23` (quota/metrics/retention/tests) — consumes the tenant-partitioned engine for Prometheus labeling and the retention policy.
- **Downstream consumers (later phases):**
  - G6 (Status page) — `Monitor.sendStats` already tenant-scoped; public status page query uses `monitorListByTenant[resolvedTenantId]`.
  - G8 (Billing) — quota enforcement hooks into `startMonitor` (max monitors per tenant check).
  - G9 (Audit log) — wraps the `startMonitor`/`pauseMonitor`/`deleteMonitor` calls.
  - G10 (DevOps) — the tenant-partitioned map is single-process; G10's Redis adapter makes it cluster-safe.
- **Behavioral parity contract:**
  - Existing tests pass — default-tenant admin's monitors start, heartbeat, stop exactly as before.
  - The `monitorList` compat getter ensures no runtime crash for code that hasn't migrated yet.
  - No payload shape changes — only the underlying data structures are partitioned.

## Acceptance criteria

- [ ] `server.uptimeKumaServer.monitorListByTenant` is the canonical map; `monitorList` is a deprecated getter returning `monitorListByTenant["default"]`.
- [ ] `startMonitors()` iterates tenants, loads per-tenant active monitors, and starts them with staggered delays.
- [ ] `startMonitor(tenantId, userID, monitorID)` creates the monitor in `monitorListByTenant[tenantId]`, not in a flat map.
- [ ] `pauseMonitor` / `restartMonitor` / `shutdownFunction` operate on `monitorListByTenant`.
- [ ] `UptimeCalculator.getUptimeCalculator(tenantId, monitorID)` looks up `listByTenant[tenantId]`.
- [ ] `Monitor.sendStats(io, tenantId, monitorID, userID)` emits to the tenant-scoped room.
- [ ] `afterLogin(socket, user)` iterates `monitorListByTenant[socket.tenantID]` only.
- [ ] Default-tenant admin backward-compat: `npm run test-backend` passes without regression.
- [ ] `npm run lint` passes on all modified files.
- [ ] No new files; no changes outside the listed files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Confirm monitorListByTenant is the canonical map
grep -n "monitorListByTenant" server/uptime-kuma-server.js server/server.js
grep -n "monitorList\b" server/uptime-kuma-server.js  # should only appear in the deprecated getter

# 2. Confirm startMonitors iterates tenants
grep -A 20 "async function startMonitors" server/server.js | grep -E "tenant|findForTenant"

# 3. Confirm UptimeCalculator partitioned
grep -n "listByTenant\|getUptimeCalculator.*tenantId" server/uptime-calculator.js

# 4. Confirm sendStats signature migrated
grep -n "static.*sendStats.*tenantId" server/model/monitor.js

# 5. Lint
npx eslint server/uptime-kuma-server.js server/server.js server/uptime-calculator.js server/model/monitor.js

# 6. Regression
npm run test-backend 2>&1 | tail -40

# 7. Quick smoke: start the server, check that monitors load and heartbeat
#    (manual: npm run dev, watch logs for "Started monitor" messages)
```

## Reviewer

Backend engine lead / Uptime Kuma maintainer. Must verify that the tenant-partitioned maps are correct, the backward-compat getter is safe, and the startup order (iterating tenants → loading monitors → staggered start) doesn't introduce regressions.

## Explicit out-of-scope items

- **Quota enforcement** (max monitors, min check interval, notification rate limit) — belongs to `task-23`.
- **Prometheus `tenant_id` label** — belongs to `task-23`.
- **Per-tenant heartbeat retention** — belongs to `task-23`.
- **Noisy neighbor fairness** (per-tenant tick loop staggering) — belongs to `task-23`.
- **Notification dispatch tenant context** (payload enrichment) — belongs to `task-22`.
- **Heartbeat `tenant_id` column** — G1 `task-05` already handled this; heartbeat rows are child-attributed to `monitor` (FK-anchored isolation).
- **Redis adapter** for multi-instance — G10 owns this.
- **Frontend changes** — G7 owns the UI.
- **Audit log writes** — G9 owns audit logging.
- **Billing-tier quotas** — G8 owns billing.