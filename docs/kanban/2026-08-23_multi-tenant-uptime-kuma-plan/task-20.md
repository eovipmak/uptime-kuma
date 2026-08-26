# Task G4.20 — Cross-Tenant IDOR Test Suite + Cache-Key Namespace Adoption

**Phase:** G4 — Repository / Query Layer
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Security lead / Uptime Kuma maintainer (G4 closing signoff)

## Objective

Deliver the test suite that proves G4's "Definition of Done": **100% cross-tenant IDOR pass** — a tenant-A user cannot read, mutate, or destroy tenant-B's data via any tenant-A socket/HTTP path. Plus, apply the `tenantCacheKey` namespace prefix from `task-17` wherever the codebase hand-writes a cache key (so G10's Redis adapter can adopt the namespace without a last-minute key-string sweep).

This task **closes Phase G4**.

## Prerequisites/dependencies

- **Task G4.17, G4.18, G4.19** all reviewed and approved:
  - 17 — wrapper, ESLint rule, cache namespace.
  - 18 — socket-handler call sites migrated.
  - 19 — model + uptime-kuma-server methods migrated.
- **Phase G3 (13/14/15/16)** approved — RBAC gates the role dimension; this task asserts the tenant dimension.
- **Phase G2 (09/10/11/12)** approved — the in-process socket.io test harness from `task-12` is reused.
- **G1 task-07 (demo seed)** approved — three demo tenants (Acme, XYZ, 123) with monitors/notifications each; the IDOR tests use fixtures built on these.
- **If 17/18/19 is incomplete:** stop, write no tests against a moving wrapper contract, report the blocker.

## Owner / recommended agent profile

**Backend test engineer (security)** — same profile as `task-16` (RBAC tests); fluent with the Node.js test runner, the socket.io harness from G2 `task-12`, Supertest for HTTP (already added as devDep by `task-16` if not present), and IDOR test scaffolding.

## Exact files and artifacts to create or modify

1. **Create** `test/backend-test/test-tenant-idor.js` — the G4 cross-tenant IDOR acceptance suite (the deliverable). Patterns mirror `test-tenant-auth.js` (`task-16`) and `test-rbac.js` (`task-16`).
2. **Modify** `server/notification.js`, `server/uptime-calculator.js`, `server/prometheus.js` (if any in-process cache is used), and any other module that hand-writes a cache-key string (`"monitor:..."`, `"stat:..."`, `"badge:..."`) — adopt `tenantCacheKey(tenantId, key)` per `task-17`. **Touch only the cache-key string; do not refactor the rest of the file.**
3. **No other files** — the wrapper (17), handlers (18), and models (19) are already migrated.

## Concrete implementation steps

1. Re-read `task-17.md` (wrapper, cache-namespace contract), `task-18.md` (migrated handlers), `task-19.md` (migrated models), and the existing IDOR test patterns (`test-tenant-auth.js`, `test-rbac.js`). The IDOR suite is G4's safety net; if the model/handler migrations left a leak, this suite catches it.
2. **`test/backend-test/test-tenant-idor.js`** — Node.js test runner (`describe`/`test`); structure:
   - **`before`** — reuse the in-process Socket.IO server harness from `task-12` (or import the shared helper; if none, copy with attribution and note "mirrors test-tenant-auth.js setup"). Seed via G1 `task-07`'s demo seed so we have three tenants (Acme, XYZ, 123) each with monitors, notifications, status pages, tags, maintenance.
   - **Setup helper** — `loginAsTenantRole(tenantSlug, role)` returns `{ socket, token, tenantId, userId }` so each test can quickly log in as acme-tenant-admin, xyz-member, etc.
   - **Monitor IDOR tests** — for each of the 11 mutation+read monitor endpoints (`getMonitor`, `editMonitor`, `deleteMonitor`, `pauseMonitor`, `resumeMonitor`, `getMonitorBeats`, `clearEvents`, `clearHeartbeats`, `clearStatistics`, `addMonitorTag`, `editMonitorTag`, `deleteMonitorTag`):
     - Login as a member of tenant A.
     - Identify a `monitorID` belonging to tenant B (from the seed).
     - Emit the event with the tenant-B `monitorID`.
     - Assert the callback returns null (`getMonitor`, `getMonitorBeats`) or `{ ok: false}` (mutations) — never tenant B's monitor attribute or heartbeat list.
   - **Notification IDOR** — `getNotificationList`, `deleteNotification` with a tenant-B `notificationID` rejected.
   - **Status page IDOR** — authenticated-editor path `saveStatusPage` with a tenant-B `slug` rejected; `getStatusPage(slug)` returns null for tenant B's slug from a tenant-A socket (the public anonymous read is a separate, separate test below).
   - **Tag IDOR** — `editTag`, `deleteTag` with a tenant-B `tagID` rejected.
   - **Maintenance IDOR** — `getMaintenance`, `pauseMaintenance`, etc. with a tenant-B `maintenanceID` rejected — the tenant-A socket does not see tenant B's maintenance in its list.
   - **Proxy / Docker / Remote-browser / API-key IDOR** — same shape for each tenant-owned resource.
   - **HTTP IDOR tests** — use Supertest to hit `GET /api/<route>`/`POST /switch-tenant`/etc with a tenant-A token and a forged `X-Tenant-ID` for tenant B (G2 `task-10` already validates the header membership-rejection path; here, we verify the query layer also rejects even if the header bypass were possible).
   - **Public-status-page anonymous flow** (a positive test, not a leak) — fetch a status page via its slug without authentication; verify it resolves via the G2 router's subdomain/custom-domain resolver, not via a tenant-context filter (this is the documented exemption from `task-18`/`task-19`).
   - **Default-tenant backward-compat IDOR** — the default-tenant admin (single-tenant install) sees all default-tenant monitors; no other-tenant "default" can exist in the seed, so the default tenant's isolation is preserved.
   - **Cache-key prefix visual test** — assert that whatever cache key the codebase writes for tenant A's monitor list starts with `tenant:${tenantAId}:` (the contract from `task-17`). Use a small instrumented Redis mock if one exists in devDeps; otherwise, monkey-patch the cache internals to capture the key string.
3. **Cache-key adoption** (`server/notification.js`, `server/uptime-calculator.js`, `server/prometheus.js`, and any module with a hand-written `"monitor:" + ...` or `"badge:" + ...` cache key):
   - Grep `"monitor:" | "stat:" | "badge:" | "uptime:"` and similar string concatenations in `server/`.
   - For each, adopt `tenantCacheKey(tenantId, key)`.
   - Where the module does not have a tenantId in scope (e.g., `uptime-calculator.js` keyed by `monitorID`), **first verify the monitor's `tenant_id`** via the `task-19`-migrated `Monitor.getCachedMonitor(monitorID, tenantId)` (if not present, fall back to a `Monitor.findOneForTenant` lookup once per monitor; cache the tenant_id on the monitor bean in memory). Document any module where a per-tenant cache lookup isn't possible without a schema change and raise a blocker against `task-17` or `task-19` rather than silently bypassing.
   - For modules that genuinely have **no tenant context** (e.g., `server/prometheus.js` system metrics), the cache key stays un-prefixed with an inline `// cache key not tenant-scoped; metric is global` rationale.
4. JSDoc on any new test helper. `.eslintrc.js` style.
5. Run `npm run test-backend` and confirm the new suite passes 100% with zero regression.

## Interfaces/contracts and integration points

- **Upstream consumers (within G4):** consumes the wrapper from `task-17`, the migrated handlers from `task-18`, and the migrated models from `task-19`. If a test reveals a leak, raise a blocker against the appropriate task.
- **Downstream consumers (later phases):**
  - G9 (Security/Observability) — the IDOR suite is the baseline for the post-hardening pentest; G9's cross-tenant pen-test extends, not replaces, these cases.
  - G11 (Testing) — the load test scenario's IDOR random-probe cases build on this file's fixture.
  - G10 (DevOps) — the cache-key namespace adoption here is the contract G10's Redis adapter will consume; no key-string surprise for G10.
- **Test contract:** running `npm run test-backend` must pass on SQLite (and, when MariaDB CI is enabled, on MariaDB) with the new IDOR suite included.

## Acceptance criteria

- [ ] `test/backend-test/test-tenant-idor.js` exists and is registered with the backend test glob.
- [ ] For each tenant-owned resource domain (monitor, notification, status page, tag, maintenance, proxy, docker_host, remote_browser, api_key), at least one IDOR test exists for each of (read, mutate) verbs — the matrix is the union of `task-14` (socket verbs) and `task-15` (HTTP verbs).
- [ ] A tenant-A user (any role) cannot read, mutate, or destroy tenant-B's data via any tenant-A socket path.
- [ ] The public-status-page anonymous flow (positive test) verifies that the G2 router resolves the tenant via hostname, not via a query filter — i.e., the exemption documented in `task-18`/`task-19` is correctly preserved.
- [ ] The default-tenant admin (single-tenant install) has zero IDOR regressions (every default-tenant operation the existing `test/backend-test/*.test.js` covers still works).
- [ ] Cache-key hand-writes in `server/notification.js`, `server/uptime-calculator.js`, `server/prometheus.js`, and any other module with a per-monitor/per-status-page cache key have adopted `tenantCacheKey(tenantId, key)`.
- [ ] Modules without tenant context (e.g., system metrics) carry an inline `// cache key not tenant-scoped; metric is global` comment.
- [ ] `npm run test-backend` passes 100% on SQLite (and on MariaDB if CI enables it) — additive suite, zero regression.
- [ ] `npm run lint` passes on every modified/created file.
- [ ] No changes outside `test/backend-test/test-tenant-idor.js`, `server/notification.js`, `server/uptime-calculator.js`, `server/prometheus.js`, and any other cache-key-bearing module (verify with `git status`).

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint test/backend-test/test-tenant-idor.js server/notification.js server/uptime-calculator.js server/prometheus.js

# 2. Test file registered
grep -nE 'idor' test/test-backend.mjs 2>/dev/null || node --test test/backend-test/test-tenant-idor.js 2>&1 | head -5

# 3. IDOR coverage — each domain must appear in the test file
for domain in monitor notification status_page tag maintenance proxy docker_host remote_browser api_key; do
  grep -q "IDOR.*${domain}\|${domain}.*IDOR\|${domain}_idor\|${domain}_id_or\|describe\(.*[\"']${domain}.*IDOR" test/backend-test/test-tenant-idor.js && echo "OK domain: $domain" || echo "MISSING domain: $domain"
done

# 4. Cache key prefix adoption
grep -rn '"monitor:\|"stat:\|"badge:\|"uptime:' server/ | grep -v 'tenantCacheKey\|tenant:\|// cache key not tenant-scoped' | head

# 5. Run the new suite
node --test test/backend-test/test-tenant-idor.js 2>&1 | tail -20

# 6. Regression
npm run test-backend 2>&1 | tail -40

# 7. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(test/backend-test/test-tenant-idor\.js|server/notification\.js|server/uptime-calculator\.js|server/prometheus\.js)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Security lead / Uptime Kuma maintainer — **this is the final Phase G4 signoff**. Specifically confirms:
- (a) **every** tenant-owned domain has at least one IDOR test for read and mutate,
- (b) a tenant-A user (any role) **cannot** leak tenant-B data via any path the test exercises — and the test exercises the full `task-14` socket verb surface + the `task-15` HTTP route surface,
- (c) the public-status-page anonymous read **still works** (no accidental tenant-guard on the public path),
- (d) the default-tenant admin (legacy single-tenant install) has zero regressions (`test/backend-test/*.test.js` all pass),
- (e) the cache-key namespace is adopted wherever a cache key hand-write was found; un-adopted keys are documented with a global-metric rationale,
- (f) the suite is deterministic (no flake; no dependence on wall-clock timing beyond the G2-established `runOnce()` patterns).

Only after reviewer signoff, append the coordinator-status block and close Phase G4.

## Explicit out-of-scope

- **Do not** implement or modify the Redis adapter — that is G10. This task only adopts the key-prefix contract so G10's adapter procurement is mechanical.
- **Do not** add aggregator/badge key handling for everything — only adopt `tenantCacheKey` where a tenant-owned key was previously hand-written. **System metrics** (per-process, cross-tenant) stay un-prefixed.
- **Do not** re-migrate `task-18`/`task-19`'s call sites — this task tests them; if a leak is found, raise a blocker against the responsible sibling task, do not patch here.
- **Do not** introduce fixtures outside the G1 `task-07` demo seed (or inline fixtures built on its documented structure) — synthesizing tenants outside the documented structure invites drift between this suite and the G11 load test.
- **Do not** add load/stress test scenarios — G11. This file is functional IDOR only.
- **Do not** touch the public anonymous status page routing logic — G6 owns its hostname-based resolver. This task only exercises the *positive* path (it works) and trusts G6 to handle the routing internals.
- **Do not** add audit-log assertions — G9 writes the rows; this task does not assert audit_log content.
- **Do not** change the wrapper (`task-17`), the rule, or the cache namespace shape — those are frozen by 17.
- **Do not** re-thread `task-18` or `task-19` to use the audit-trail variant of the wrapper — that's a G9 mechanical update. G4 ships only the plain `findOneForTenant`/`findForTenant`/`execForTenant`/`dispenseForTenant` variants on the data path; the audited variant is for G9.
- **Do not** add resource-owner (per-user-within-tenant) tests — G3's matrix + G4's tenant filter are the two layers; ownership is a non-goal of the plan (the plan's "Member quản lý notification của mình" is enforced socially via the `user_id` filter remaining alongside `tenant_id`, not via a separate role check).

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-26T00:30:00Z
- Verification: PR #51 review — G4.20 IDOR suite + cache-key namespace adoption per task-20 checklist (a)-(f). Verified: test/backend-test/test-tenant-idor.js 38/38 pass 0 fail (node --test), cache-key audit suite 2/2 pass, grep for hand-written "monitor:/stat:/badge:" keys shows only tenantCacheKey or global-metric annotated paths, all 9 tenant-owned domains have read+mutate IDOR cases (monitor 12-event matrix, notification, status_page, tag, maintenance, proxy, docker_host, remote_browser, api_key), public-status-page anonymous flow positive test passes, default-tenant backward compat 2/2 pass. G4.21 hardening (5ab34eee) threaded socket.tenantID into 8 missed model call sites, now un-skipped in IDOR suite (previous 6 skips resolved). Lint clean on IDOR file, tsc clean. Backend suite failure set identical to baseline (pre-existing env failures only).
- Commit or artifact reference: PR #51 squash merge 854b0f20 (feat G4.20 + fix G4.21). Branch feat/g4-20-idor-suite commits 945dc00d, 6bab83fa, 4d65155c, df40b74a, f2ed8b13 squash-merged. Phase G4 Definition of Done met.
