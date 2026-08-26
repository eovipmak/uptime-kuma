# Task G5.22 — Heartbeat Writer & Notification Dispatcher Tenant-Aware

**Phase:** G5 — Monitoring Engine Multi-Tenant
**Status:** todo
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Backend engine lead / Uptime Kuma maintainer

## Objective

Wire tenant context through the heartbeat write path and notification dispatch path so that every heartbeat is stored with the correct `tenant_id` (via the monitor FK), every heartbeat is emitted to the correct tenant-scoped socket room, and every notification dispatch carries the tenant context in its payload. The `Monitor.start()` → `beat()` closure is the central touchpoint; this task also ensures the `clearOldData` background job is tenant-aware.

This task consumes the contracts frozen by `task-21` (partitioned `monitorListByTenant`, `UptimeCalculator.getUptimeCalculator(tenantId, monitorID)`, `Monitor.sendStats(io, tenantId, monitorID, userID)`).

## Prerequisites/dependencies

- **Task G5.21** reviewed and approved — tenant-partitioned `monitorListByTenant`, `UptimeCalculator.listByTenant`, `Monitor.sendStats(io, tenantId, ...)` signature, `startMonitor(tenantId, ...)` signature all frozen.
- **Phase G4 (17/18/19/20)** approved — `findOneForTenant`/`findForTenant`/`execForTenant`/`dispenseForTenant` wrapper available; model static methods accept `tenantId`.
- **Phase G2 (09/10/11/12)** approved — tenant-scoped Socket.IO rooms (`userRoom(tenantId, userID)`) are set up.
- **Phase G1 (04/05/06/08)** approved — `tenant_id` on `monitor` table; heartbeat rows are FK-anchored to `monitor` (no separate `tenant_id` column needed on `heartbeat`).
- **Can run in parallel with `task-23`** — disjoint file sets (heartbeat/notification path vs quota/metrics/retention/tests). Both consume `task-21`'s frozen contract, not each other's output.
- **If `task-21` is incomplete:** stop, report the blocker, do not write heartbeat/notification code against a moving engine contract.

## Owner / recommended agent profile

**Backend engine engineer** — deep understanding of the `Monitor.start()` → `beat()` async closure (the heartbeat lifecycle), the `Monitor.sendNotification()` / `Monitor.getNotificationList()` / `Notification.send()` dispatch chain, and the `clearOldData` background job in `server/jobs/clear-old-data.js`. Must track the full flow from `R.dispense("heartbeat")` → `R.store(bean)` → `io.to(room).emit("heartbeat", ...)` → `Monitor.sendNotification(...)` → `Notification.send(...)`.

## Exact files and artifacts to create or modify

1. **Modify** `server/model/monitor.js` **(primary — `beat()` closure, ~line 414–1200):**
   - Capture `tenantId = this.tenant_id` at the top of the `beat()` closure (the monitor row already has `tenant_id` from G1 `task-05`).
   - `R.dispense("heartbeat")` → `dispenseForTenant("heartbeat", tenantId)` (G4 wrapper — sets `bean.tenant_id` on the new row; the heartbeat table may or may not have a `tenant_id` column depending on G1's schema decision; the wrapper handles both cases).
   - `io.to(this.user_id).emit("heartbeat", bean.toJSON())` → `io.to(userRoom(tenantId, this.user_id)).emit("heartbeat", bean.toJSON())` (the `userRoom` helper from G2 `task-11`).
   - `Monitor.sendStats(io, this.id, this.user_id)` → `Monitor.sendStats(io, tenantId, this.id, this.user_id)`.
   - `Monitor.sendCertInfo(io, this.id, this.user_id)` → `Monitor.sendCertInfo(io, tenantId, this.id, this.user_id)`.
   - `Monitor.sendDomainInfo(io, this.id, this.user_id)` → `Monitor.sendDomainInfo(io, tenantId, this.id, this.user_id)`.
   - `Monitor.sendNotification(isFirstBeat, this, bean)` already carries `this` (the monitor object) which has `tenant_id` — `sendNotification` will thread it through.
2. **Modify** `server/model/monitor.js` — `Monitor.sendNotification(isFirstBeat, monitor, bean)` (line ~1452):
   - `Monitor.getNotificationList(monitor)` → `Monitor.getNotificationList(monitor, monitor.tenant_id)`.
   - `Notification.send(JSON.parse(notification.config), msg, monitorJSON, heartbeatJSON)` → `Notification.send(JSON.parse(notification.config), msg, monitorJSON, heartbeatJSON, monitor.tenant_id)`.
3. **Modify** `server/model/monitor.js` — `Monitor.getNotificationList(monitor)` (line ~1538):
   - Signature extends to `static async getNotificationList(monitor, tenantId)`.
   - The SQL query becomes tenant-scoped: `SELECT notification.* FROM notification, monitor_notification WHERE monitor_id = ? AND notification.id = monitor_notification.notification_id AND notification.tenant_id = ?` (or reuse the wrapper's `findForTenant` for the notification portion).
   - The monitor's `tenant_id` is verified against the `notification` table's `tenant_id` column (defense-in-depth: the G1 schema has `tenant_id` on both `monitor` and `notification`; the join asserts they match).
4. **Modify** `server/notification.js` — `Notification.send(notification, msg, monitorJSON, heartbeatJSON)`:
   - Signature extends to `static async send(notification, msg, monitorJSON = null, heartbeatJSON = null, tenantId = null)`.
   - The `monitorJSON` and `heartbeatJSON` payloads are enriched with `tenant_id: tenantId` for the notification provider's use (e.g., email template may include tenant name).
   - The `this.providerList[notification.type].send(...)` call passes `tenantId` through.
5. **Modify** `server/notification.js` — `applyNotificationEveryMonitor(notificationID, userID)`:
   - Signature extends to `applyNotificationEveryMonitor(notificationID, userID, tenantId)`.
   - The monitor-fetch query becomes `findForTenant("monitor", "user_id = ?", [userID], tenantId)`.
6. **Modify** `server/jobs/clear-old-data.js`:
   - The current `Database.clearHeartbeatData()` is a SQLite `PRAGMA` — it's a DB-level vacuum, not per-tenant.
   - For multi-tenant, the heartbeat DELETE must be tenant-scoped: iterate tenants, then for each tenant run `DELETE FROM heartbeat WHERE monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?) AND time < ?` (retention period). The `PRAGMA incremental_vacuum` still runs globally after all tenant-scoped deletes.
   - The `stat_daily` / `stat_hourly` / `stat_minutely` cleanup uses the same `monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)` pattern.
7. **No new files** — all work is refactoring existing paths.

## Concrete implementation steps

1. Re-read `task-21.md` (partitioned engine contracts), `task-17.md` (wrapper), `task-11.md` (room keys), and `task-19.md` (model method signatures).
2. **`beat()` closure migration:**
   - At the top of `start(io)`'s `beat()` definition, after `const self = this;`, add `const tenantId = self.tenant_id;`.
   - Replace `R.dispense("heartbeat")` with `dispenseForTenant("heartbeat", tenantId)`.
   - Replace `io.to(self.user_id).emit("heartbeat", ...)` with `io.to(userRoom(tenantId, self.user_id)).emit("heartbeat", ...)`.
   - Replace `Monitor.sendStats(io, self.id, self.user_id)` with `Monitor.sendStats(io, tenantId, self.id, self.user_id)`.
   - Replace `Monitor.sendCertInfo(io, self.id, self.user_id)` with `Monitor.sendCertInfo(io, tenantId, self.id, self.user_id)`.
   - Replace `Monitor.sendDomainInfo(io, self.id, self.user_id)` with `Monitor.sendDomainInfo(io, tenantId, self.id, self.user_id)`.
   - For the `Monitor.isUnderMaintenance(self.id)` call: the maintenance list is now tenant-partitioned (`task-21`); update to `Monitor.isUnderMaintenance(tenantId, self.id)` or thread `tenantId` through the maintenance lookup.
3. **`sendNotification` migration:**
   - `Monitor.getNotificationList(monitor)` → `Monitor.getNotificationList(monitor, tenantId)`.
   - The notification provider's `send()` call receives `tenantId` as the last argument so providers can log/label per tenant.
4. **`getNotificationList` migration:**
   ```js
   static async getNotificationList(monitor, tenantId) {
       const notificationList = await R.getAll(
           `SELECT notification.* FROM notification
            INNER JOIN monitor_notification ON notification.id = monitor_notification.notification_id
            WHERE monitor_notification.monitor_id = ? AND notification.tenant_id = ?`,
           [monitor.id, tenantId]
       );
       return notificationList;
   }
   ```
   Or use the `TenantScopedQueryBuilder` from `task-17` for the notification portion.
5. **`Notification.send` migration:**
   - Add `tenantId = null` as the last parameter (default null for backward compat with test code).
   - Enrich `monitorJSON.tenant_id = tenantId` and `heartbeatJSON.tenant_id = tenantId` before passing to the provider.
   - The provider's `send(notification, msg, monitorJSON, heartbeatJSON)` signature is unchanged — `tenantId` is embedded in the JSON payloads.
6. **`applyNotificationEveryMonitor` migration:**
   - `R.getAll("SELECT id FROM monitor WHERE user_id = ?", [userID])` → `findForTenant("monitor", "user_id = ?", [userID], tenantId)`.
7. **`clear-old-data.js` migration:**
   ```js
   async function clearOldData() {
       const tenants = await R.find("tenant", " status = 'active' ");
       const cutoff = dayjs.utc().subtract(keepDataPeriodDays, 'day').toISOString();
       for (const tenant of tenants) {
           // Delete heartbeats for this tenant's monitors
           await R.exec(
               `DELETE FROM heartbeat WHERE monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?) AND time < ?`,
               [tenant.id, cutoff]
           );
           // Delete stat records for this tenant's monitors
           await R.exec(
               `DELETE FROM stat_daily WHERE monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?) AND timestamp < ?`,
               [tenant.id, cutoff]
           );
           // Similar for stat_hourly, stat_minutely
       }
       // Global vacuum (SQLite-specific)
       await Database.clearHeartbeatData();
   }
   ```
   If the `tenant` table is empty (legacy single-tenant), fall back to the original behavior (DELETE without tenant filter).
8. **JSDoc** on every modified method's new `tenantId` parameter.
9. Run `npm run test-backend` — default-tenant admin regression must pass.

## Interfaces/contracts and integration points

- **Upstream consumers (G5):** `task-21`'s partitioned `monitorListByTenant`, `UptimeCalculator.getUptimeCalculator(tenantId, monitorID)`, `Monitor.sendStats(io, tenantId, ...)`.
- **Upstream consumers (G4):** `dispenseForTenant`, `findForTenant` from `task-17`.
- **Upstream consumers (G2):** `userRoom(tenantId, userID)` from `task-11`.
- **Downstream consumers (within G5):**
  - `task-23` (quota/metrics) — Prometheus metrics are updated in `beat()` after the heartbeat is stored; the `tenantId` is now available for `monitor_status` label enrichment.
- **Downstream consumers (later phases):**
  - G6 (Status page) — public status page reads `heartbeat` via `monitorListByTenant[tenantId]`; the tenant-scoped `io.to(userRoom(...))` emit means the status page socket subscribes to the right room.
  - G9 (Audit log) — `sendNotification` is a hook point for audit logging.
  - G10 (DevOps) — `clearOldData` per-tenant iteration is the contract for a future Redis-backed job queue.
- **Behavioral parity contract:**
  - Existing tests pass — default-tenant admin's heartbeat flow and notification dispatch are unchanged.
  - The `io.to(userRoom(tenantId, userID))` room key matches `task-11`'s exact format.
  - Notification providers receive `tenant_id` in the JSON payload (backward compat: existing providers ignore unknown fields).

## Acceptance criteria

- [ ] `beat()` closure uses `dispenseForTenant("heartbeat", tenantId)` and emits to `userRoom(tenantId, self.user_id)`.
- [ ] `Monitor.sendStats(io, tenantId, ...)` / `sendCertInfo` / `sendDomainInfo` all thread `tenantId`.
- [ ] `Monitor.sendNotification` passes `tenantId` through to `Notification.send`.
- [ ] `Monitor.getNotificationList(monitor, tenantId)` joins with `notification.tenant_id` filter.
- [ ] `Notification.send` enriches `monitorJSON` and `heartbeatJSON` with `tenant_id`.
- [ ] `applyNotificationEveryMonitor` scopes to `tenantId`.
- [ ] `clearOldData` iterates tenants and deletes heartbeat/stat records per tenant.
- [ ] `clearOldData` falls back to the original behavior when `tenant` table is empty (legacy single-tenant).
- [ ] Default-tenant admin backward-compat: `npm run test-backend` passes without regression.
- [ ] `npm run lint` passes on all modified files.
- [ ] No new files; no changes outside the listed files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Confirm beat() closure captures tenantId
grep -n "tenantId.*=.*tenant_id\|tenant_id.*tenantId" server/model/monitor.js

# 2. Confirm heartbeat emit uses userRoom(tenantId, ...)
grep -n "userRoom.*tenantId\|userRoom.*tenant_id" server/model/monitor.js

# 3. Confirm sendNotification passes tenantId
grep -A 5 "static async sendNotification" server/model/monitor.js | grep "tenantId"

# 4. Confirm getNotificationList has tenantId filter
grep -A 10 "static async getNotificationList" server/model/monitor.js | grep -E "tenant_id|tenantId"

# 5. Confirm clearOldData iterates tenants
grep -A 10 "async function clearOldData" server/jobs/clear-old-data.js | grep "tenant"

# 6. Lint
npx eslint server/model/monitor.js server/notification.js server/jobs/clear-old-data.js

# 7. Regression
npm run test-backend 2>&1 | tail -40

# 8. Quick smoke: create a monitor, wait for heartbeat, check io.to(userRoom(...)) emit
#    (manual: npm run dev, check browser console for heartbeat events)
```

## Reviewer

Backend engine lead / Uptime Kuma maintainer. Must verify that the heartbeat emit room is correctly scoped, the notification dispatch chain carries tenant context end-to-end, and `clearOldData` correctly restricts deletes to each tenant's data.

## Explicit out-of-scope items

- **Prometheus `tenant_id` label** — belongs to `task-23`.
- **Quota enforcement** (notification rate limit per tenant) — belongs to `task-23`.
- **Per-tenant heartbeat retention policy** (Free: 7 days, Pro: 90 days) — belongs to `task-23`.
- **Noisy neighbor mitigation** — belongs to `task-23`.
- **Notification provider template per-tenant** (white-label email) — out of scope for the entire plan unless requested.
- **Redis adapter** — G10 owns this.
- **Frontend changes** — G7 owns the UI.
- **Audit log writes** — G9 owns audit logging.

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-26T01:28:00Z
- Verification: PR #55 review — G5.22 heartbeat writer & notification dispatcher tenant-aware per task-22 checklist. Verified: beat() captures tenantId = this.tenant_id (monitor.js:440) and emits via userRoom(roomTenantID, userID) (1088), sendStats/sendCertInfo/sendDomainInfo threaded tenantId (1362,1410,1439), isUnderMaintenance checks tenantId (491), getNotificationList(monitor, tenantId) asserts notification.tenant_id = ? via resolveTenantId (1608-1615), sendNotification threads monitor.tenant_id (1033,1530), Notification.send enriches monitorJSON/heartbeatJSON with tenant_id (260-267), applyNotificationEveryMonitor uses findForTenant (368), clearOldData per-tenant retention loop via monitor_id IN subquery with legacy fallback (53-88). Deviation documented: R.dispense heartbeat kept (no tenant_id column per ADR-0002, frozen schema probe fails dispenseForTenant) — in-scope per task out-of-scope note. Lint 0 errors (134 warnings baseline), tsc clean, master CI lint/tsc/build green, backend suites 34/35 pass = master baseline (D-016 containers excluded), inline 9/9 probe via Echo verification.
- Commit or artifact reference: PR #55 squash merge 8ec1e98f (feat G5.22 heartbeat writer & notification dispatcher tenant-aware, KUM-207). Branches feat/g5-22-heartbeat-notification-tenant (67e6fe2d + 924d3994). Kanban task-22 done, unblocks G5.23 rebase.