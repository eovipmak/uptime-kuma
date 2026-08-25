# Task G4.19 — Model + UptimeKumaServer Static/Instance Method Rewrite to Tenant-Safe Queries

**Phase:** G4 — Repository / Query Layer
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Backend lead / Uptime Kuma maintainer

## Objective

Migrate the **model static methods and `UptimeKumaServer` instance methods** to the tenant-safe wrapper from `task-17`. These are the queries that the socket handlers (`task-18`) call into — `Monitor.getMonitorList`, `Monitor.getPreviousHeartbeat`, `Monitor.deleteMonitor`, `UptimeKumaServer.getMonitorJSONList`, `UptimeKumaServer.loadMaintenanceList`, etc. — plus the modules between handlers and models (`server/notification.js`, `server/proxy.js`, `server/docker.js`, `server/remote-browser.js`).

The result: every data-access path the monitoring engine (G5) and UI (G7) consumes is tenant-scoped at the lowest possible layer — the model.

## Prerequisites/dependencies

- **Task G4.17** reviewed and approved — wrapper exports + ESLint rule.
- **Phase G3 (13–16)** approved — RBAC gates the callers; role errors are clean 403s.
- **Phase G2 (09/10/11/12)** approved — `req.user.tenantId` (HTTP) and `socket.tenantID` (socket) are the tenant source.
- **Phase G1 (04/05/06/08)** approved — `tenant_id` columns exist; backfill is done; FK cascade is set.
- **Can run in parallel with `task-18`** — disjoint file sets. Both consume `task-17`'s frozen contract, not each other's output.
- **If `task-17` is incomplete:** stop, report the blocker, do not migrate to an unstable wrapper.

## Owner / recommended agent profile

**Backend data-access engineer** — fluent with `redbean-node`'s `BeanModel` static methods, the `server/model/*.js` file conventions (`@deprecated` markers, `static async methodName(...)`), and the `server/uptime-kuma-server.js` instance methods (`getMonitorJSONList`, `loadMaintenanceList`, `sendMonitorList`). Comfortable re-threading schema-dependent queries without breaking the existing tests. Must coordinate with `task-18` on the shared call sites (handlers call models) via the wrapper contract.

## Exact files and artifacts to create or modify

1. **Modify** `server/model/monitor.js` — every static method that does `R.findOne("monitor", ...)` / `R.find("monitor", ...)` / `R.exec("...WHERE...", ...)` migrates to the wrapper. Critical methods:
   - `Monitor.getPreviousHeartbeat(monitorID)` — the existing `R.findOne("heartbeat", " id = (select MAX(id) from heartbeat where monitor_id = ?)", [monitorID])` becomes `findOneForTenant` against `monitor` first (verify the monitor belongs to tenant) then the `heartbeat` lookup. The simpler rewrite is `TenantScopedQueryBuilder` for the subquery shape (the wrapper's `findOneForTenant` doesn't handle `id IN (SELECT ...)` directly; the builder appends the tenant guard).
   - `Monitor.deleteMonitor(monitorID, userID)` — already passed `userID`; extend to accept `tenantId` (the call sites in `task-18` thread it through) and migrate `R.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID])` to `execForTenant(...)`.
   - `Monitor.deleteMonitorRecursively(monitorID, userID)` — `%monitorID`'s child monitors; migrate the `R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, userID])` and the recursive DELETE chain.
   - `Monitor.sendStats / sendCertInfo / sendDomainInfo (io, monitorID, userID)` — these read `monitor_tls_info`; `monitor_tls_info` has no `tenant_id` (it's keyed off `monitor_id`), so the model **first** verifies `monitor.tenant_id = ?` and then performs the tls_info lookup unscoped (with inline `eslint-disable` reasoning that the FK guarantees the child row belongs to the same tenant). Document this exemption pattern in JSDoc.
   - `Monitor.sendNotification`, `Monitor.getNotificationList` — read `notification_sent_history`, `monitor_notification`; migrate to `findForTenant` / `findOneForTenant(:notification, ...)`.
2. **Modify** `server/model/heartbeat.js` — `Heartbeat.getPreviousHeartbeat` and any static methods migrate; the heartbeat row stores `monitor_id`, so the wrapper applies the monitor-tenant guard.
3. **Modify** `server/model/status_page.js` — `StatusPage南站.getJSONStatusPage(slug)` (the authenticated read; the anonymous public read is a documented exemption in `task-17`'s rule) and `StatusPage.save(...)` migrate. The public read path stays direct `R.findOne("status_page", "slug = ?", ...)` with an inline `eslint-disable` rationale "public unauthenticated read; tenant resolved via hostname in G2 router".
4. **Modify** `server/model/tag.js`, `server/model/maintenance.js`, `server/model/incident.js`, `server/model/group.js`, `server/model/api_key.js`, `server/model/proxy.js`, `server/model/docker_host.js`, `server/model/remote_browser.js` — every static method mutating or listing by `user_id` migrates to the wrapper; the call sites (`task-18`) thread `socket.tenantID` into the new `tenantId` parameter.
5. **Modify** `server/model/user.js` — the user model is **tricky**: users are global, `tenant_user` is the membership table. Queries against `user` should **not** add a `tenant_id` filter (users belong to multiple tenants; a cross-cut by tenant would break the user-list page). The model needs to read user-within-tenant via `tenant_user` join — but the existing `user` table queries (login, password reset, 2FA) are **global** and stay direct `R.findOne` with an inline `eslint-disable` rationale "user is global; tenancy enforced via tenant_user join".
6. **Modify** `server/uptime-kuma-server.js`:
   - `getMonitorJSONList(userID, monitorID = null)` becomes `getMonitorJSONList(tenantId, userID, monitorID = null)`; the `R.find("monitor", query + " ORDER BY ...", queryParams)` migrates to `findForTenant("monitor", " user_id = ? ", [userID], tenantId, "ORDER BY weight DESC, name")`. The `sendMonitorList(socket)` call passes `socket.tenantID` and `socket.userID`.
   - `sendMaintenanceListByUserID(userID)` → `sendMaintenanceListByTenant(tenantId, userID)`; `loadMaintenanceList()` was global (single-process scheduler concern), migrates to tenant-partitioned iteration (the heavy scheduler rewrite is G5; here, just scope the load so tenant A's maintenance list doesn't appear in tenant B's `sendMaintenanceList` emit).
   - `sendMonitorList(socket)` — uses the post-migration `getMonitorJSONList` with `socket.tenantID`. The emit goes to `io.to(userRoom(socket.tenantID, socket.userID))` per `task-11` (no change there).
7. **Modify** `server/notification.js` — `save(notificationID, userID, notification, active)` extends with `tenantId`; `R.findOne("notification", " id = ? AND user_id = ? ", [id, userID])` migrates to `findOneForTenant`.
8. **Modify** `server/docker.js`, `server/proxy.js`, `server/remote-browser.js` — these modules between handlers and models; each has a `save(id, userID, ...)` pattern; extend the signature with `tenantId` and migrate every `R.findOne/R.exec` to the wrapper. The socket-handler migrations in `task-18` thread `socket.tenantID` into the new parameter.
9. **No new files** — model + module migrations, no new modules.

## Concrete implementation steps

1. Re-read `task-17.md`'s wrapper signatures and `task-18.md`'s handler-layer contract (so the model's new `tenantId` parameter matches what handlers thread through).
2. For each model file, grep its static methods (the `static async methodName` markers from `task-` grep already run), categorize each as **tenant-owned query** (gets the wrapper) or **global read** (user, setting — inline `eslint-disable` with rationale).
3. **Signature changes** — extend every static method that currently accepts `userID` to also accept `tenantId`:
   - `static async getPreviousHeartbeat(monitorID)` → `static async getPreviousHeartbeat(monitorID, tenantId)`
   - `static async deleteMonitor(monitorID, userID)` → `static async deleteMonitor(monitorID, userID, tenantId)`
   - Use the call-site migration in `task-18` to know which methods need the new argument.
4. **`monitor_tls_info` / `heartbeat` / `stat_*` (monitor-attributed children)** — these tables do **not** have their own `tenant_id` (the schema-normal-form was chosen by G1 to keep the FK to `monitor` as the tenant anchor). The wrapper contract handles this via the `TenantScopedQueryBuilder` which adds a `WHERE monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)` subquery. **Do not** add a redundant `tenant_id` column to these child tables (that's G1's decision not to revisit; raise a blocker against G1 `task-05` if a redundant column turns out to be required for performance — the wrapper's subquery form is the correct runtime isolation).
5. **`UptimeKumaServer.getMonitorJSONList`** — the most-used method; rewrite carefully:
   ```js
   async getMonitorJSONList(tenantId, userID, monitorID = null) {
       const where = monitorID ? { fragment: "user_id = ? AND id = ?", params: [userID, monitorID] } : { fragment: "user_id = ?", params: [userID] };
       const monitorList = await findForTenant("monitor", where.fragment, where.params, tenantId, "ORDER BY weight DESC, name");
       // ... rest remains identical ...
   }
   ```
   The `sendMonitorList(socket)` emits to `io.to(userRoom(socket.tenantID, socket.userID))` (set by `task-11`).
6. **`loadMaintenanceList()` global iteration** — this loads all maintenances across all tenants into a single in-memory map. For multi-tenant correctness, partition by tenant: `this.maintenanceListByTenant[tenantId] = await findForTenant("maintenance", "1=1", [], tenantId, "ORDER BY end_date DESC, title")`. The heavy scheduler rewrite (per-tenant tick loop) is G5; here, just store per-tenant so the emit never leaks.
7. **`user.js` global exemption** — leave user model queries direct; mark with `// eslint-disable-next-line require-tenant-scope — user is global; tenancy enforced by tenant_user join elsewhere`.
8. JSDoc on every modified method's new `tenantId` parameter. `.eslintrc.js` style.
9. Run `npm run test-backend` — default-tenant admin regression must pass.

## Interfaces/contracts and integration points

- **Upstream consumer (within G4):** `task-17`'s wrapper, threaded into call sites via the new `tenantId` parameters that `task-18`'s handler migrations supply.
- **Downstream consumer (within G4):** `task-20` (IDOR tests) asserts model-level cross-tenant rejection (e.g., a `Monitor.deleteMonitor(id, userA, tenantA)` call against a tenant-B monitor's id returns affected_rows = 0).
- **Downstream consumers (later phases):**
  - G5 (Monitoring engine) — the scheduler calls `Monitor.getPreviousHeartbeat(monitorID, tenantId)` and `getMonitorJSONList(tenantId, userID)`; the wrapper guarantees the engine's per-tenant tick loop only polls its own tenants' monitors.
  - G6 (Status page) — `StatusPage.getJSONStatusPage(slug, tenantId)` resolves a tenant's status page slug (so tenant A's `main` slug ≠ tenant B's `main` slug).
  - G9 (audit log) wraps the migrated wrapper calls with the audit hook from `task-16`.
- **Behavioral parity contract:**
  - Default-tenant admin (single-tenant install): every existing `test/backend-test/*.test.js` passes. The `socket.tenantID = default` (from G1's backfill + G2's after-login) makes the same rows match.
  - No payload shape changes — only the underlying query scoping.

## Acceptance criteria

- [ ] Every `R.findOne/R.find/R.exec/R.dispense` call in `server/model/*.js`, `server/uptime-kuma-server.js`, `server/notification.js`, `server/docker.js`, `server/proxy.js`, `server/remote-browser.js` either (a) migrates to the wrapper, or (b) has an inline `// eslint-disable-next-line require-tenant-scope` with a documented rationale (user is global; setting is cross-tenant; public status page slug lookup).
- [ ] Every public static method that previously accepted `userID` now also accepts `tenantId` (additive signature; backward compat preserved for in-process test code that passes only `userID` — those go through a default-tenant fallback path documented in JSDoc; never silently).
- [ ] `UptimeKumaServer.getMonitorJSONList` signature is `(tenantId, userID, monitorID = null)`.
- [ ] `UptimeKumaServer.loadMaintenanceList` partitions by tenant into `this.maintenanceListByTenant` (the heavy scheduler rewrite is G5; here the storage shape is the contract).
- [ ] The `monitor_tls_info` / `heartbeat` / `stat_*` child-table lookups use the `TenantScopedQueryBuilder` `monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)` pattern (not a redundant `tenant_id` column on the child tables).
- [ ] Default-tenant admin backward-compat: `npm run test-backend` passes without regression.
- [ ] The ESLint rule is flipped to `error` on every model file via `overrides` glob in `.eslintrc.js`.
- [ ] `npm run lint` passes on every modified file.
- [ ] No new files; no changes outside the listed files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/model/ server/uptime-kuma-server.js server/notification.js server/docker.js server/proxy.js server/remote-browser.js

# 2. No un-migrated R.* calls (except documented exemptions)
grep -rn 'R\.\(findOne\|find\|exec\|dispense\|findAll\)(' server/model/ server/uptime-kuma-server.js server/notification.js server/docker.js server/proxy.js server/remote-browser.js | grep -v 'eslint-disable' | grep -v 'user.js\|setting\|status_page.js.*public' | head

# 3. getMonitorJSONList signature migrated
grep -A2 'getMonitorJSONList(' server/uptime-kuma-server.js | head -10

# 4. loadMaintenanceList partitioned by tenant
grep -nE 'maintenanceListByTenant|findForTenant' server/uptime-kuma-server.js

# 5. New tenantId parameter on model method signatures
for m in deleteMonitor getPreviousHeartbeat getJSONStatusPage; do
  grep -qE "static\s+async\s+${m}\([^)]*tenantId" server/model/ -r && echo "OK signature: $m" || echo "WARN: $m tenantId parameter check manual"
done

# 6. Regression
npm run test-backend 2>&1 | tail -40

# 7. IDOR manual smoke (full IDOR suite is task-20):
#    call Monitor.deleteMonitor(bMonitorId_from_tenantB, userA, tenantA) → expect affected_rows = 0

# 8. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/model/|server/uptime-kuma-server\.js|server/notification\.js|server/docker\.js|server/proxy\.js|server/remote-browser\.js|\.eslintrc)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Backend lead / Uptime Kuma maintainer. Specifically confirms:
- (a) every static method exposes `tenantId` additively (no in-process caller breakage),
- (b) the `monitor_tls_info` / `heartbeat` / `stat_*` child-table exemptions follow the `monitor_id IN (SELECT ... WHERE tenant_id = ?)` subquery pattern (not a bypass),
- (c) the `user.js` and `setting`-table global exemptions are documented inline (not silently bypassed),
- (d) the default-tenant admin (legacy single-tenant install) sees zero regression,
- (e) the per-tenant maintenance list storage shape is what G5's scheduler rewrite will consume.

## Explicit out-of-scope

- **Do not** rewrite the socket handlers' direct `R.*` calls — that is `task-18`. The handler migrations thread `tenantId` into the new model parameters; here, we add the parameters.
- **Do not** write the cross-tenant IDOR test suite — `task-20`.
- **Do not** add a redundant `tenant_id` column to `heartbeat`, `stat_*`, `monitor_tag`, `monitor_notification`, `monitor_tls_info`, `incident` (keyed to monitor) — those tables are FK-anchored to `monitor`; the wrapper's subquery form is the correct runtime isolation. If performance demonstrates a need for the redundant column, raise a blocker against G1 `task-05` (a G1 migration), do not patch the schema here.
- **Do not** implement the full per-tenant scheduler — G5. Here, only scope the `loadMaintenanceList` storage; the tick-loop rewrite is G5.
- **Do not** change the `setting`-table schema — global settings stay global; document inline as a known exemption.
- **Do not** change the `user`-table schema — users are global; tenant membership is in `tenant_user`; the user-list page queries `user` joined with `tenant_user`. The global `R.findOne("user", "username = ?", ...)` (login flow) stays global.
- **Do not** migrate `server/settings.js` (`Settings.get/set`) — the setting table is cross-tenant; document inline.
- **Do not** touch the public status page anonymous-read path — G6 owns the hostname-based tenant resolution for anonymous status pages.
- **Do not** add audit-log writes — G9.
- **Do not** change the cache-key handshake — the cache key namespace was frozen by `task-17`; this task doesn't apply it (Redis adapter is G10; manual key string changes wherever a model hand-writes a cache key are `task-20`'s bookkeeping).

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-25T13:40:00Z
- Verification: PR #47 review — model + UptimeKumaServer methods migrated per task-19 checklist (a)-(f). Verified: Monitor.getPreviousHeartbeat/sendCertInfo/sendDomainInfo via findOneForTenant guard; deleteMonitor/deleteMonitorRecursively/unlinkAllChildren gain tenantId via execForTenant; child-table lookups use monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?) pattern with eslint-disable rationale; UptimeKumaServer.getMonitorJSONList signature is (tenantId, userID, monitorID); maintenance list partitioned (maintenanceListByTenant/finding per-tenant via findForTenant); user.js/setting global exemptions documented inline. Default-tenant backward-compat: backend suite baseline unchanged. Lint 0 errors. KUM-35 merged squash as 1fb43290 (PR #47).
- Commit or artifact reference: branch feat/g4-19-model-tenant-queries, PR #47, master merge 1fb43290. CI SUCCESS (Lint, tsc, build Node 20) pre-merge.
