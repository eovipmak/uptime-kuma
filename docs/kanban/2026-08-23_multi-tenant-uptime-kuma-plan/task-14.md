# Task G3.14 — Socket-Handler RBAC Enforcement Sweep

**Phase:** G3 — RBAC (Role-Based Access Control)
**Status:** todo
**Reviewer:** Realtime/socket lead / Uptime Kuma maintainer

## Objective

Thread the RBAC helpers from `task-13` (`checkRole` / `checkPermission` + `PERMISSIONS`) into every existing socket handler under `server/socket-handlers/` and the inline `socket.on(...)` registrations in `server/server.js`, so that each mutation endpoint is gated by the correct permission and each read endpoint is open to `VIEWER` and above. The result: **every Socket.IO business event** is RBAC-protected, with the role coming from `socket.role` set by G2 + G3 `task-13`.

This task does **not** change payloads or event names — it is a mechanical enforcement sweep layered on top of the tenant-context invariants G2 already guarantees via `checkLogin(socket)`.

## Prerequisites/dependencies

- **Task G3.13** reviewed and approved — `ROLES_PERMISSIONS`, `buildAbilityFor(role)`, `checkRole(socket, ...roles)`, `checkPermission(socket, permission)`, `getSocketRole(socket)`, `PERMISSIONS` enum, and the `socket.role` set by `server.js` `afterLogin` are all in place.
- **Phase G2 (09/10/11/12) approved** — `checkLogin(socket)` now asserts `socket.tenantID` exists; `socket.role` is set during `afterLogin`.
- **If `task-13` is incomplete:** stop, report the blocker, do not write enforcement against an unverified matrix/contract.

## Owner / recommended agent profile

**Socket-handler maintainer** — fluent with the existing `server/socket-handlers/*.js` registration pattern (the `socket.on("event", async (arg, callback) => { checkLogin(socket); … })` shape), `server/client.js` emit helpers, and the `server/server.js` inline `socket.on(...)` block. Must execute a mechanical, mechanical sweep without altering payload shapes. Reads many files, writes only the enforcement layer.

## Exact files and artifacts to create or modify

Each handler file is touched only to insert a `checkPermission` (or `checkRole`) call immediately after the existing `checkLogin(socket)` call. No other change in those files.

1. **Modify** `server/socket-handlers/general-socket-handler.js` — gate `getGameList` (read) implicitly allowed for `VIEWER+` (no new check needed; default the open-access ones to `viewer`), but if any mutation handler exists here (e.g., `setSettings`, `getPM2ProcessList`), apply `PERMISSIONS.TENANT_SETTINGS_UPDATE` (mutation → tenant_admin).
2. **Modify** `server/socket-handlers/api-key-socket-handler.js` — every handler (`addAPIKey`, `editAPIKey`, `deleteAPIKey`, `getAPIKeyList`) → `PERMISSIONS.API_KEY_MANAGE` (`tenant_admin`). Read of the API key list itself is allowed for `VIEWER+` per the existing UX (keys are visible to all logged-in members of the tenant — confirm with the existing code; if the existing behavior hides keys from non-admins, add `PERMISSIONS.API_KEY_MANAGE` to the read path too; otherwise leave read open per "preserve oveservable behavior").
3. **Modify** `server/socket-handlers/maintenance-socket-handler.js` — `addMaintenance`/`editMaintenance`/deleteMaintenance`/`pauseMaintenance`/`resumeMaintenance` → `PERMISSIONS.MAINTENANCE_MANAGE` (`tenant_admin`); read handlers (`getMaintenanceList`, `getMaintenance`) → viewers (`PERMISSIONS` not additionally called for read — same as viewer default). The public-facing maintenance status is consumed via status page (public, no auth).
4. **Modify** `server/socket-handlers/proxy-socket-handler.js` — `addProxy`/`updateProxy`/`deleteProxy` → `PERMISSIONS.PROXY_MANAGE` (`tenant_admin`); `getProxyList` → viewer default.
5. **Modify** `server/socket-handlers/docker-socket-handler.js` — `addDockerHost`/`updateDockerHost`/`deleteDockerHost` → `PERMISSIONS.DOCKER_HOST_MANAGE` (`tenant_admin`); `getDockerHostList` → viewer default.
6. **Modify** `server/socket-handlers/status-page-socket-handler.js` — `addStatusPage`/`updateStatusPage`/`deleteStatusPage` → `PERMISSIONS.STATUS_PAGE_CREATE` / `UPDATE` / `DELETE` (`tenant_admin`); `getStatusPage`/`getStatusPageList` → `PERMISSIONS.STATUS_PAGE_READ` (viewer — explicit because status pages have both public and authenticated views; the authenticated-editor view is viewer+, public view is unauthenticated handled elsewhere).
7. **Modify** `server/socket-handlers/remote-browser-socket-handler.js` and `cloudflared-socket-handler.js` — these manage tenant-operational resources; gate mutations against `PERMISSIONS.TENANT_SETTINGS_UPDATE` (`tenant_admin`) since the plan doesn't enumerate a dedicated permission for cloudflared/remote-browser (raise RFC if a finer-grained permission is needed; do not silently invent).
8. **Modify** `server/socket-handlers/database-socket-handler.js` — `clearEvents`, `clearHeartbeats`, `clearStatistics` → `PERMISSIONS.MONITOR_DELETE` (treating heartbeat-clear as a destructive mutation; tenant_admin), or a closer equivalent — confirm with `task-13`'s matrix; if `task-13` does not ship such a permission, raise a blocker.
9. **Modify** `server/socket-handlers/chart-socket-handler.js` — read-only handlers → viewer default (no new check needed unless a mutation exists; verify).
10. **Modify** `server/server.js` inline socket handlers — the existing `add`/`editMonitor`/`deleteMonitor`/`pauseMonitor`/`resumeMonitor`/`addMonitorTag`/`editMonitorTag`/`deleteMonitorTag` block calls `checkLogin(socket)` already; insert the matching `checkPermission(...)` after each `checkLogin(socket)`:
    - `add` (monitor), `addMonitorTag`, `editMonitorTag` → `PERMISSIONS.MONITOR_CREATE`.
    - `editMonitor`, `deleteMonitorTag` → `PERMISSIONS.MONITOR_UPDATE`. (deleteMonitorTag is an attribute-edit on monitor tagging; treat as update for now — if matrix in task-13 splits it, follow task-13 exactly.)
    - `deleteMonitor` → `PERMISSIONS.MONITOR_DELETE` (`tenant_admin`).
    - `pauseMonitor`, `resumeMonitor` → `PERMISSIONS.MONITOR_PAUSE_RESUME` (`member`).
    - `getMonitorList`, `getMonitor`, `getMonitorBeats`, `monitorImportantHeartbeatListCount/Paged` (read) → viewer default (no new check unless task-13 requires explicit `MONITOR_READ`; default is allow for viewer+).
    - `addTag`, `editTag`, `deleteTag` → `PERMISSIONS.TAG_MANAGE` (`member` per matrix: "Tạo/sửa monitor được cấp, quản lý notification của mình" — tags are shared resource used by member's monitors; treat as `member`).
    - `addNotification`, `testNotification` → `PERMISSIONS.NOTIFICATION_CREATE` (`member`); `deleteNotification` → `PERMISSIONS.NOTIFICATION_DELETE` (`member` per plan: "quản lý notification của mình").
    - `changePassword`, `setSettings`, `addStatusPage` (if inline rather than in handler) → `PERMISSIONS.TENANT_SETTINGS_UPDATE` (`tenant_admin`).
    - `clearEvents`, `clearHeartbeats`, `clearStatistics` (if inline rather than in `database-socket-handler.js`) — same as item 8 (tenant_admin destructive).
    - `prepare2FA`, `save2FA`, `disable2FA`, `verifyToken`, `twoFAStatus` — these are owner-only self-service (user manages their own 2FA), no role needed beyond `checkLogin(socket)` (everyone manages their own 2FA). **No new RBAC check**; document the rationale inline with a comment.
11. **Modify** `server/server.js` — the `switchTenant` handler (added by G2 `task-11`) does its own membership re-resolution; do not add an RBAC check that conflicts with the membership check. But add: only `MEMBER+` can switch tenants within a session? **No** — the plan says nothing restricting tenant-switch by role (switching is a user-level action, available to all roles including `VIEWER`). Leave `switchTenant` unguarded by RBAC; its check is membership (G2 `task-11` already enforces this). Add a comment explaining the deliberate exemption.
12. **No new files** — this task reuses `task-13`'s exports; it does not ship new modules.

## Concrete implementation steps

1. Re-read `docs/kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-13.md` and the role matrix. The matrix is the source of truth; document any place where this sweep finds the matrix missing a capability (e.g., a notification "test" path) — raise as blocker against `task-13`, do not invent.
2. For each socket handler file:
   - Grep `socket.on\(` to enumerate every registered event.
   - Categorize each as **mutation** (add/edit/delete/clear/pause/resume — needs a permission) or **read** (get/list/status — viewer default; no new check).
   - For each mutation, insert immediately after the existing `checkLogin(socket);` line:
     ```js
     checkPermission(socket, PERMISSIONS.<DOMAIN>_<ACTION>);
     ```
     where the constant is imported at the top of the file alongside `checkLogin`:
     ```js
     const { checkLogin } = require("../util-server");
     const { checkPermission } = require("../rbac/socket-rbac");
     const { PERMISSIONS } = require("../rbac/permissions");
     ```
   - For read endpoints, add no check; instead add a `// RBAC: read, viewer+ OK (no check needed)` comment so reviewers can see the read was annotated.
3. For inline handlers in `server/server.js` (the ones not delegated to a handler module), apply the same pattern in place.
4. **Pay special attention to `changePassword`** — the `changePassword` handler currently calls `doubleCheckPassword`; that is the user's own password (not a tenant-scoped resource). Don't gate it with a tenant permission — self-service operations stay ungated. Same for 2FA. Add inline comment.
5. **Pay special attention to `setSettings`** — `setSettings` mutates server-wide settings (e.g., the entry page, monitoring interval global default). Gate with `PERMISSIONS.TENANT_SETTINGS_UPDATE` (`tenant_admin`). The legacy single-tenant admin (default-tenant `tenant_admin` from G1 task-06) still has this permission — backward compatible.
6. **Pay special attention to `switchTenant`** — explicitly annotate that switching is open to all roles (membership, not role, gates it). Comment + no new check.
7. Batch-grep after the sweep: `grep -rL "checkPermission\|checkRole\|RBAC:" server/socket-handlers/ server/server.js` → list the files that have neither a check nor an annotation; investigate each, decide whether it's all-read (annotation only) or all-self-service (annotation only).
8. JSDoc on any new local helper (none expected — this is a mechanical insert). `.eslintrc.js` style.
9. Run the existing `npm run test-backend` regression — every existing test must still pass for users that were previously treated as administrators (the default-tenant admin has `tenant_admin` role per G1, so all checks pass for it; backward-compatible).

## Interfaces/contracts and integration points

- **Upstream consumer (within G3):** `task-13`'s `checkPermission`/`checkRole` and `PERMISSIONS` enum — this task imports them; no new symbols.
- **Downstream consumer (within G3):** `task-16` (test suite) asserts every mutation event is now rejected for `VIEWER` and accepted for `TENANT_ADMIN`. The matrix tested in this task's G3 acceptance is the one fixed in `task-13`.
- **Downstream consumers (later phases):**
  - G4 (Repository layer) — every socket mutation handler is already RBAC-gated before the repository call site; G4's per-owner resource check (e.g., "this monitor belongs to the tenant of the edited row") runs after the role check. The two layers compose: role first (cheap), then owner (DB-backed).
  - G5 (Monitoring engine) — `pauseMonitor`/`resumeMonitor` actor now has a role; the engine respects the state change without role re-check.
  - G9 (Audit log) — every mutation gated by `checkPermission` is a candidate for an `audit_log` row; G9 will hook the `TranslatableError` boundary + a wrapper around `checkPermission` to emit the row. This task does not do the audit write.
- **Behavioral parity contract:**
  - Event names unchanged.
  - Payload shapes unchanged.
  - Every mutation that **was** allowed for the single-tenant admin (default-tenant `tenant_admin`) is still allowed (matrix subset invariant).
  - The legacy single-tenant admin's effective capability surface is unchanged (no regression).

## Acceptance criteria

- [ ] Every mutation socket event in `server/socket-handlers/*.js` and the inline `server/server.js` socket handlers has a `checkPermission(socket, PERMISSIONS.<...>)` call inserted immediately after `checkLogin(socket)`.
- [ ] Every read socket event is annotated with an `RBAC: read, viewer+` comment indicating the read-vs-mutation decision was deliberate.
- [ ] Self-service events (`changePassword`, `prepare2FA`/`save2FA`/`disable2FA`/`verifyToken`/`twoFAStatus`, `switchTenant`, `logout`, `login`/`loginByToken`/`setup`) are explicitly annotated as deliberately NOT RBAC-gated (user-self-service).
- [ ] Default-tenant admin (G1 `tenant_admin`) can still perform every operation they could pre-G3 — verified by running the existing `test/backend-test/` regression.
- [ ] A synthesized `viewer` socket role is rejected on `add`/`editMonitor`/`deleteMonitor` via a `TranslatableError("forbiddenPermission")`. (Manual verification OK — full matrix coverage is `task-16`.)
- [ ] `npm run lint` passes on every modified file.
- [ ] No changes outside `server/socket-handlers/*.js` and `server/server.js`. No new files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/socket-handlers/ server/server.js

# 2. No mutation handler missing checkPermission
# (Heuristic: list mutation verbs and assert checkPermission appears after the handler)
patterns="^socket\.on\(\s*[\"'](add|edit|delete|pause|resume|clear|save|update|disable)[A-Za-z]*"
for f in server/socket-handlers/*.js server/server.js; do
  if grep -nE "$patterns" "$f" >/dev/null 2>&1; then
    if ! grep -q "checkPermission\|checkRole" "$f"; then
      echo "WARN: $f has mutation handlers but no checkPermission import — verify all mutations are self-service"
    fi
  fi
done

# 3. Imports added
grep -rL 'require("../rbac/socket-rbac")\|require("../rbac/permissions")' server/socket-handlers/ server/server.js | grep -E 'socket' | head

# 4. Regression
npm run test-backend 2>&1 | tail -40

# 5. Manual smoke (run via a small fixture in task-16 if needed):
#    login as viewer → emit "addMonitor" → expect forbiddenPermission
#    login as tenant_admin → emit "addMonitor" → expect ok

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/socket-handlers/|server/server\.js)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Realtime/socket lead / Uptime Kuma maintainer. Specifically confirms:
- (a) **every** mutation socket event has a `checkPermission` (or documented self-service exemption),
- (b) **no payload shape or event name changed** (regression suite passes),
- (c) the default-tenant admin (single-tenant install) has zero new restrictions (backward compatible),
- (d) read events are correctly **left ungated** (viewers can read what they could read before; the matrix doesn't add read-restrictions the plan didn't call for),
- (e) the permission constant for each mutation matches `task-13`'s frozen matrix exactly — no invented constants.

## Explicit out-of-scope

- **Do not** change the RBAC matrix or `PERMISSIONS` enum — that is `task-13`. If a mutation has no matching permission, raise a blocker, don't invent.
- **Do not** add HTTP `/api` route enforcement — that is `task-15`. The two sweeps are independent because socket handlers and HTTP routes have disjoint file sets, but they must not conflict on the matrix.
- **Do not** write the G3 acceptance-test suite — that is `task-16`. Smoke tests for "viewer rejected, tenant_admin allowed" are fine but the exhaustive matrix belongs in `task-16`.
- **Do not** touch the public status page socket (`monitor-${monitorID}` room used by unauthenticated status-page viewers) — G6 owns that; only authenticated user-room emits are affected by this sweep.
- **Do not** add audit-log writes inside handlers — G9.
- **Do not** change `checkLogin(socket)` itself — G2 `task-11` froze it.
- **Do not** introduce resource-owner checks (e.g., a Member editing another Member's monitor) — G4. The Member's permission to edit any monitor in their tenant is the plan's design ("tạo/sửa monitor được cấp" — granted monitors); resource-owner granularity is G4's layer.
- **Do not** add permission checks to the `login`/`loginByToken`/`setup` flow — those run **before** `socket.role` is set; per G2 task-09 they're the flow that establishes the role claim. `checkLogin` itself is the only assertion there.
- **Do not** break the existing `doubleCheckPassword` flow — keep it intact next to any new `checkPermission(...)` call.
