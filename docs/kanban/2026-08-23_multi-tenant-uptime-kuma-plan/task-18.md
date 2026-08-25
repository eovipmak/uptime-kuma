# Task G4.18 — Socket-Handler Call-Site Rewrite to Tenant-Safe Queries

**Phase:** G4 — Repository / Query Layer
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Realtime/socket lead / Uptime Kuma maintainer

## Objective

Migrate every `R.findOne` / `R.find` / `R.exec` / `R.dispense` call site in the **socket-handler layer** (`server/socket-handlers/*.js` + the inline `socket.on(...)` block in `server/server.js` + the list/emit helpers in `server/client.js`) to the tenant-safe wrapper from `task-17`. The `socket.userID`-scoped WHERE fragments become `(socket.tenantID, socket.userID)`-scoped or pure `socket.tenantID`-scoped queries depending on whether the row is tenant-owned (filter by `tenant_id`) or user-owned-within-tenant (filter by `tenant_id, user_id`).

Critically, the **monitorNotification / monitor_tag / heartbeat / stat_*** tables are joined to `monitor`, and the `monitor` row carries the tenant — so a `monitor_id`-scoped query must also assert `tenant_id` matches `socket.tenantID` (defense-in-depth against a client passing a monitor_id belonging to another tenant).

## Prerequisites/dependencies

- **Task G4.17** reviewed and approved — the wrapper exports (`findOneForTenant`, `findForTenant`, `execForTenant`, `dispenseForTenant`, `TenantScopedQueryBuilder`) and the ESLint rule `uptime-kuma/require-tenant-scope` are in place.
- **Phase G3 (13/14/15/16)** approved — `checkPermission(socket, ...)` runs before any data-access call (RBAC gate is upstream; RBAC failure is a clean 403, not a query).
- **Phase G2 (09/10/11/12)** approved — `socket.tenantID` is guaranteed set by `checkLogin(socket)` (G2 task-11).
- **If `task-17` is incomplete:** stop, report the blocker, do not migrate to a wrapper that may still be shifting its signature.
- **Can run in parallel with `task-19`** — disjoint file sets (socket-handlers + client vs model + uptime-kuma-server). Both consume `task-17`'s frozen contract only.

## Owner / recommended agent profile

**Socket-handler maintainer** — same profile as `task-14` (the RBAC sweep); fluent with the existing `socket.on("event", async (arg, callback) => { checkLogin(socket); … })` pattern and `server/client.js` emit helpers. This task is a mechanical call-site migration layered on top of `task-14`'s RBAC additions.

## Exact files and artifacts to create or modify

Each file is touched only to swap `R.findOne/find/exec/dispense` for the wrapper variants and to thread `socket.tenantID` into the new call's tenantId parameter. No handler-level logic change.

1. **Modify** `server/server.js` — the inline `socket.on("add"|"editMonitor"|"deleteMonitor"|"pauseMonitor"|"resumeMonitor"|"getMonitor"|"getMonitorList"|"getMonitorBeats"|"addTag"|"editTag"|"deleteTag"|"addMonitorTag"|"editMonitorTag"|"deleteMonitorTag"|"clearEvents"|"clearHeartbeats"|"clearStatistics"|"addNotification"|"deleteNotification"|"testNotification"|"changePassword"|"setSettings"|...)` block. Every `await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID])` becomes `await findOneForTenant("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID], socket.tenantID)`. Every `await R.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID])` becomes `await execForTenant("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID], socket.tenantID)`.
2. **Modify** `server/client.js` — the list helpers (`sendNotificationList`, `sendMonitorList`, `sendProxyList`, `sendAPIKeyList`, `sendDockerHostList`, `sendRemoteBrowserList`) currently use `R.find(table, " user_id = ? ", [socket.userID])`. Migrate to `findForTenant(table, " user_id = ? ", [socket.userID], socket.tenantID, "ORDER BY ...")` so a switched-tenant user receives only their tenant's list.
3. **Modify** `server/socket-handlers/api-key-socket-handler.js` — `addAPIKey`/`editAPIKey`/`deleteAPIKey` calls to `APIKey.save(key, socket.userID)` migrate to pass `socket.tenantID` (the model's `save` accepting tenantId is implemented in `task-19`; here, only the call site is changed to thread tenantId through).
4. **Modify** `server/socket-handlers/maintenance-socket-handler.js` — `addMaintenance`'s `R.dispense("maintenance")` becomes `dispenseForTenant("maintenance", socket.tenantID)`; `bean.user_id = socket.userID` stays (user-ownership within tenant); mutations become `execForTenant(...)`.
5. **Modify** `server/socket-handlers/proxy-socket-handler.js`, `docker-socket-handler.js`, `remote-browser-socket-handler.js`, `cloudflared-socket-handler.js` — same migration pattern per the `R.*` calls each file currently has.
6. **Modify** `server/socket-handlers/status-page-socket-handler.js` — `addStatusPage`/`updateStatusPage`/`deleteStatusPage` migrations; the public-status-page read path (slug-based lookup for anonymous viewers) is **G6's** concern, not this task — annotate those reads as // RBAC: public per task-15 and leave them on direct `R.findOne` (marked `eslint-disable` with rationale).
7. **Modify** `server/socket-handlers/chart-socket-handler.js` and `database-socket-handler.js` — `clearEvents`/`clearHeartbeats`/`clearStatistics` migrate to `execForTenant` so a cleared-statistics call only affects the active tenant's data.
8. **Modify** `server/socket-handlers/general-socket-handler.js` — `setSettings` and any direct `R.exec` on `setting` table stays (setting is cross-tenant system config; `task-17` documented this exemption) but the per-tenant `setting` extensions (if any exist post-G1) flow through `execForTenant`.
9. **No new files** — pure call-site migration; reuse `task-17`'s exports.

## Concrete implementation steps

1. Re-read `task-17.md` (wrapper signatures) and `task-14.md` (where `checkPermission` was inserted in each handler — the queries to migrate sit immediately after those gates).
2. For each handler file:
   - At the top, add: `const { findOneForTenant, findForTenant, execForTenant, dispenseForTenant } = require("../repository");` alongside the existing `const { checkLogin } = require("../util-server");`.
   - Enumerate `R.findOne/R.find/R.exec/R.dispense` calls (the grep `R\.\(findOne\|find\|exec\|dispense\) ` should match exactly once per call site).
   - For each, decide the tenant-scope shape:
     - **Tenant-owned, user-attributed rows** (`monitor`, `notification`, `proxy`, `docker_host`, `remote_browser`, `api_key`, `maintenance`) → keep the `user_id = ?` fragment AND add `tenant_id = ?` via the wrapper: `findOneForTenant(table, "id = ? AND user_id = ?", [id, socket.userID], socket.tenantID)`. This is defense-in-depth: even if the `user_id` matches, a tenant mismatch is a hard rejection.
     - **Tenant-owned, monitor-attributed rows** (`heartbeat`, `stat_minutely`/`stat_hourly`/`stat_daily`, `monitor_tag`, `monitor_notification`, `incident`, `monitor_tls_info`) → the call needs to verify the **monitor** belongs to the tenant before deleting its child rows: use `execForTenant("DELETE FROM heartbeat WHERE monitor_id = ?", [monitorID], socket.tenantID, { requireId: false })` and have the wrapper confirm `monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)`. For simplicity, the wrapper's `execForTenant` handles this via a WHERE-exists clause when `opts.requireId: false` is set (see `task-17` step 2). Document any escape hatch.
   - After migration, the file's `R.findOne/R.find/R.exec/R.dispense` count drops to zero (except documented exemptions: `setting` table reads in `general-socket-handler.js`, public status page reads).
3. For `server/client.js` list helpers — they receive a `socket` argument already; thread `socket.tenantID` into the new `findForTenant` call. The list emit goes to `io.to(userRoom(socket.tenantID, socket.userID))` per `task-11` — already correct, no change there.
4. For inline handlers in `server/server.js` — same mechanical migration; the `socket` is in scope.
5. The existing inline `eslint-disable require-tenant-scope` comments added by `task-17`'s rule are removed as each file migrates; the rule is flipped from `warn` to `error` for that file in `.eslintrc.js` per-file or via a `// File-level eslint: require-tenant-scope error` directive (confirm the ESLint mechanism — `overrides` block per glob is the cleanest).
6. JSDoc on any new local helper (none expected). `.eslintrc.js` style.
7. Run `npm run test-backend` — the existing regression must still pass. The default-tenant admin (single-tenant install) has `socket.tenantID = default` (from G1 + G2 `task-09`), so queries still match the existing rows.

## Interfaces/contracts and integration points

- **Upstream consumer (within G4):** `task-17`'s wrapper — imports, no new surface.
- **Downstream consumer (within G4):** `task-20` (IDOR tests) asserts that a socket with `tenantID = A` cannot read `monitor` rows of tenant B via any socket event.
- **Downstream consumers (later phases):**
  - G5 (Monitoring engine) — the scheduler's monitor list comes from `R.find` queries;`task-19` migrates `uptime-kuma-server.getMonitorJSONList` to the wrapper. (This task touches only the socket layer's monitor-list emit, not the scheduler.)
  - G9 (audit log) — wraps the wrapper calls with the audit trail (from `task-16`'s hook surface).
  - G11 (testing) — extends `test-rbac.js` with cross-tenant IDOR cases rooted in this migration.
- **Behavioral parity contract:**
  - Existing tests pass — default-tenant admin's query results are unchanged (matrix subset invariant from G3 + the G1 default-tenant backfill).
  - The payload shapes of socket events are unchanged — only the underlying queries are scoped differently.

## Acceptance criteria

- [ ] Every `R.findOne/R.find/R.exec/R.dispense` call in `server/socket-handlers/*.js`, `server/server.js`'s inline socket block, and `server/client.js` either (a) is migrated to the wrapper, or (b) has an inline `// eslint-disable-next-line require-tenant-scope` with a documented exemption (the `setting`-table reads in `general-socket-handler.js`, the public-status-page slug lookups in `status-page-socket-handler.js`).
- [ ] `findForTenant` calls pass `socket.tenantID` (not `socket.userID` re-purposed) as the tenantId argument.
- [ ] No `R.exec("DELETE FROM <table> WHERE id = ?", [id])` (no-tenant guard) remains in socket handlers — every DELETE has the `tenant_id` filter via `execForTenant`.
- [ ] `dispenseForTenant(table, socket.tenantID)` is used for all `R.dispense(...)` sites in handlers (so newly-created rows are born into the correct tenant).
- [ ] Default-tenant admin backward-compat: existing `test/backend-test/*.test.js` passes without regression (queries still match the default-tenant rows).
- [ ] The ESLint rule is flipped to `error` for migrated files via `overrides` glob entries in `.eslintrc.js`; the rule remains `warn` for the rest until `task-19` migrates those files.
- [ ] `npm run lint` passes on every modified file (no `missingTenantScope` warnings on migrated files).
- [ ] No new files; no changes outside the listed files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint migrated files
npx eslint server/socket-handlers/ server/client.js server/server.js

# 2. No un-migrated R.* calls (except documented exemptions)
grep -rn 'R\.\(findOne\|find\|exec\|dispense\|findAll\)(' server/socket-handlers/ server/client.js server/server.js | grep -v 'eslint-disable' | grep -v 'setting' | grep -v 'statusPage'
echo "↑ any remaining hits must be either exemptions (setting/statusPage) or have an inline eslint-disable"

# 3. Wrapper imports added
grep -rL 'require("../repository")\|require("../repository/")' server/socket-handlers/ server/client.js server/server.js | head

# 4. Regression
npm run test-backend 2>&1 | tail -40

# 5. Quick IDOR smoke (full IDOR suite is task-20):
#    login as viewer in tenant A → emit "getMonitor" with monitorID from tenant B → expect null/403
#    (manual or scripted in task-20)

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/socket-handlers/|server/client\.js|server/server\.js|\.eslintrc)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Realtime/socket lead / Uptime Kuma maintainer. Specifically confirms:
- (a) **every** socket-handler `R.*` call is migrated or has a documented exemption,
- (b) `socket.tenantID` is threaded into the wrapper calls (not `socket.userID`),
- (c) cross-tenant monitor_id probing is rejected: a viewer passing a tenant-B monitor_id to `getMonitor` returns null,
- (d) the default-tenant admin (single-tenant install) sees no regression,
- (e) the ESLint rule is elevated to `error` on migrated files (so future regressions surface immediately),
- (f) the `setting`-table exemption is documented inline, not silently bypassed.

## Explicit out-of-scope

- **Do not** migrate `server/model/*.js` static methods — that is `task-19`. The socket-handler layer calls into models' static methods; if `Monitor.getMonitorList(userID)` still uses `R.find`, that's `task-19`'s migration target. Here, only the *direct* `R.*` calls in handlers themselves.
- **Do not** migrate `server/uptime-kuma-server.js` instance methods (`getMonitorJSONList`, `loadMaintenanceList`) — those are `task-19`'s. The socket layer calls them; their internals are migrated independently.
- **Do not** migrate `server/notification.js` or `server/proxy.js` or `server/docker.js` or `server/remote-browser.js` modules — these are between models and handlers; they're migrated in `task-19` alongside the model statics.
- **Do not** add cross-tenant IDOR tests — `task-20`.
- **Do not** change the wrapper's API — `task-17`. If this task reveals a missing wrapper variant (e.g., a `R.count` shadow), raise a blocker against `task-17`, do not patch the wrapper here.
- **Do not** touch the public status page anonymous-read path — G6 owns the slug-by-custom-domain resolution; the public read uses direct `R.findOne("status_page", "slug = ?", ...)` by design (the tenant is resolved by hostname, not by query filter), and is marked as a documented exemption per `task-17`'s rule.
- **Do not** migrate `server/settings.js` (`Settings.get/set`) — global settings are cross-tenant system config (the `setting` table has no `tenant_id`; G1 intentionally didn't add one). Document the exemption inline per file.
- **Do not** change the migrations or the seed — G1 owns database state.
- **Do not** alter the RBAC layer or `socket.tenantID` setting — those are frozen by G3 and G2.

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-25T13:40:00Z
- Verification: PR #48 review — socket-handler call sites migrated to tenant-safe wrapper per task-18 checklist (a)-(f). Verified: every R.* in server/socket-handlers/*.js, server/client.js, inline server/server.js socket block either migrated to findOneForTenant/findForTenant/execForTenant/dispenseForTenant with socket.tenantID or exempted with inline eslint-disable rationale (setting/statusPage public). Six lifecycle sites thread socket.tenantID (addMonitor->startMonitor, editMonitor->restartMonitor, resumeMonitor->startMonitor, checkOwner->findOneForTenant). ESLint overrides elevated to error for migrated files. Default-tenant backward-compat: existing backend suite baseline unchanged. Lint 0 errors on migrated files. KUM-34 merged squash as 3b6880b7 (PR #48) + follow-up KUM-178 tenant thread-through fix.
- Commit or artifact reference: branch feat/g4-18-socket-tenant-queries, PR #48, master merge 3b6880b7. CI SUCCESS (Lint, tsc, build Node 20) pre-merge.
