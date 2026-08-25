# Task G2.12 — Force-Logout on Tenant Removal + Integration Tests

**Phase:** G2 — Authentication & Tenant Context
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Security lead / Uptime Kuma maintainer (final G2 signoff)

## Objective

Implement the edge case the plan flags explicitly: **a user removed from a tenant while their session is active must be force-logged-out of that tenant's socket connections**. Plus, deliver the G2 integration test suite that proves the full chain end-to-end: login → switch → logout → invalid tenant; the test suite is the G2 Definition of Done evidence ("Test tự động cho các flow: login, switch, logout, invalid tenant").

This task closes Phase G2.

## Prerequisites/dependencies

- **Task G2.09, Task G2.10, Task G2.11** all reviewed and approved:
  - 09 → JWT `tid` claim + `socket.tenantID` wiring + `User.createJWT` extended signature.
  - 10 → `resolveTenant()` + `requireTenantContext()` + `POST /api/switch-tenant` + the shared `resolveTenantIdForInbound`.
  - 11 → `disconnectAllSocketClientsForTenant(tenantId, userId)` + `checkLogin` tenant guard + `switchTenant` socket handler + room helpers.
- **G1 task-04 / task-06** approved — `tenant_user` table is the membership source; default tenant rows exist.
- **If any G2 task is incomplete:** stop, write no tests against a moving contract, report the blocker.

## Owner / recommended agent profile

**Backend engineer (security)** — comfortable with the Node.js test runner (`node:test`), `testcontainers` for MariaDB if needed, the project's `test/mock-testdb.js` SQLite helper, and Socket.IO integration testing with the project's existing test patterns. Knows how to enumerate and reason about IDOR / session-revocation flows.

## Exact files and artifacts to create or modify

1. **Create** `server/jobs/check-tenant-membership.js` — background job that periodically (configurable, default 60s) checks every active socket for valid tenant membership and disconnects revoked ones via `disconnectAllSocketClientsForTenant`. Lifecycle: started by `uptime-kuma-server.js` `initAfterDatabaseReady()`, stopped on shutdown.
2. **Modify** `server/uptime-kuma-server.js` — register the job in `initAfterDatabaseReady()` and stop it on `stop()`. Touch only the lifecycle hooks; do not refactor unrelated code.
3. **Create** `test/backend-test/test-tenant-auth.js` — the G2 integration test suite. Patterns mirror `test/backend-test/test-migration.js` and `test-mock-testdb.js`.
4. **Optional:** extend `test/backend-test/test-migration.js` if a co-located assertion is more appropriate; do not duplicate the integration test there.
5. **No other source file** — do not modify the existing socket handlers or middleware (those are 09/10/11). The job references them read-only via the exported helpers.

## Concrete implementation steps

1. Re-read `docs/adr/ADR-0003` and the plan's G2 section: "Xử lý edge case: user bị xóa khỏi tenant khi đang online → force logout". This task delivers exactly that plus the DoD test suite.
2. **`server/jobs/check-tenant-membership.js`:**
   - Exports `startTenantMembershipCheckJob(server)` returning a `setInterval`/`AbortController` token and `stopTenantMembershipCheckJob(token)`.
   - Tick interval: env `UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS` (default `60000`); document the env in a header comment.
   - On each tick:
     - Iterate `server.io.sockets.sockets.values()`.
     - For each socket with `socket.userID` and `socket.tenantID` set (i.e., authenticated):
       - Look up `tenant_user` for `(tenant_id, user_id)`. If no row, the user was revoked from the tenant → call `server.disconnectAllSocketClientsForTenant(socket.tenantID, socket.userID, socket.id)` and emit `"forceLogoutTenant"` with `{ tenantId }` to the affected socket first so the client can show a message (i18n key `forceLogoutTenant`) before disconnect.
     - Skip unauthenticated sockets (those without `socket.userID`).
   - The job must be **safe to start multiple times** (e.g., first start only; subsequent calls are no-ops or return the existing token) and **safe to stop** without holding sockets open.
   - Use the existing `setInterval` pattern in `server/jobs/*.js` if there's a precedent — otherwise document the new pattern.
3. **`uptime-kuma-server.js` wiring:**
   - In `initAfterDatabaseReady()` (or wherever initialization completes after the database is patched), call `this.tenantCheckToken = startTenantMembershipCheckJob(this)`.
   - In `stop()`, call `stopTenantMembershipCheckJob(this.tenantCheckToken)`. Set `this.tenantCheckToken = null` after.
   - Wrap with `try/catch` so a job crash never takes the server down.
4. **`test/backend-test/test-tenant-auth.js`** — Node.js test runner (`describe`/`test`); covers:
   - **`login` flow:** seed a user with two tenants via the G1 task-07 demo seed (or manually); call login; assert the callback returns `{ ok, token, tenants, activeTenantId }`; decode the JWT and assert `tid` matches `activeTenantId` and `role` is present.
   - **`switchTenant` flow:** from the logged-in socket, emit `switchTenant` with the other tenant's id; assert callback `{ ok, token, tenantId }`; decode the new JWT and assert `tid` is now the new tenant.
   - **`logout` flow:** emit `logout`; assert `socket.userID`/`socket.tenantID` are null afterwards; room leaves effective (`socket.rooms` no longer contains the user room).
   - **`invalid tenant` flow:** forge a JWT with a `tid` for a tenant the user is not a member of (use `jwt.sign` directly with the server's jwt secret) and emit `loginByToken`; assert the callback returns `{ ok: false }` (or the membership-check prompt — task-09 step 4 specifies the fallback to the user's first accessible tenant; the test asserts that fallback fires rather than allowing the invalid tenant to leak data). Either the strict-reject path or the fallback path is acceptable **per task-09's spec** — the test must assert whichever that contract dictates; if the test reveals the task-09 spec is ambiguous, raise a blocker rather than guess.
   - **`force-logout on removal` flow:**
     - Login as a user with tenant A.
     - Directly delete the user's `tenant_user` row for tenant A from the DB (simulate admin removal).
     - Wait for the next job tick (set `UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS=100` in the test for a fast tick) **or** call the job's check function synchronously via an exported `runOnce()` helper — prefer the latter to avoid timing flakiness.
     - Assert the socket received `"forceLogoutTenant"` with `{ tenantId }` and was disconnected.
   - **HTTP `POST /api/switch-tenant` flow:** re-issue a token via the HTTP endpoint for the second tenant and assert the returned token has the correct `tid`.
   - Use `TestDB` from `test/mock-testdb.js` for SQLite setup. Add a small `before`/`after` to spawn/cleanup the socket.io server in-process (mirror how `test-migration.js` constructs Knex — adapt to Socket.IO test harness; if no precedent exists, document the harness choice in the test file header comment for reviewers).
5. Add i18n key `forceLogoutTenant` to `src/lang/en.json` (en only).
6. JSDoc on every exported function.

## Interfaces/contracts and integration points

- **Upstream consumers (within G2):**
  - The job consumes `disconnectAllSocketClientsForTenant` (from task-11), reads `socket.userID`/`socket.tenantID` (from task-09/11), and queries `tenant_user` membership (from G1 task-04).
  - The integration tests exercise the full G2 chain (09→10→11→12) end-to-end.
- **Downstream consumers (later phases):**
  - G9 (Security/Observability) will add structured audit-log entries for these force-logout events. The job's emit of `"forceLogoutTenant"` before disconnect is the hook G9 will enrich with an `audit_log` write; **do not** add the audit log itself here (it's G9).
  - G11 (Testing) extends the suite in this test file for IDOR cross-tenant assertions — owner of this file should leave it well-organized so G11 can append.
- **Lifecycle contract:** the job must start after `initAfterDatabaseReady()` and stop on `stop()`; the server must shut down cleanly even if the job is mid-tick (use `AbortController` or `clearInterval`).
- **Test contract:** running `node --test test/backend-test/test-tenant-auth.js` (or `npm run test-backend`) must pass on SQLite without manual setup beyond the existing test harness.

## Acceptance criteria

- [ ] `server/jobs/check-tenant-membership.js` exports `startTenantMembershipCheckJob`, `stopTenantMembershipCheckJob`, and `runOnce` (synchronous test hook) with JSDoc.
- [ ] Job tick iterates sockets, checks `tenant_user` membership, and triggers `disconnectAllSocketClientsForTenant` + `"forceLogoutTenant"` emit for revoked memberships.
- [ ] Job interval configurable via `UPTIME_KUMA_TENANT_CHECK_INTERVAL_MS` (default `60000`).
- [ ] `uptime-kuma-server.js` `initAfterDatabaseReady()` starts the job; `stop()` stops it; mid-tick shutdown is safe.
- [ ] `test/backend-test/test-tenant-auth.js` covers: login, switchTenant, logout, invalid-tenant, force-logout-on-removal, HTTP switch-tenant.
- [ ] The integration test suite passes via `npm run test-backend` on SQLite.
- [ ] Existing backend tests still pass (no regression — the suite is additive).
- [ ] `src/lang/en.json` contains `forceLogoutTenant`.
- [ ] `npm run lint` passes on every modified/created file.
- [ ] No changes outside `server/jobs/check-tenant-membership.js`, `server/uptime-kuma-server.js`, `test/backend-test/test-tenant-auth.js`, `src/lang/en.json`.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/jobs/check-tenant-membership.js server/uptime-kuma-server.js test/backend-test/test-tenant-auth.js src/lang/en.json

# 2. Job exports
node -e "
const j = require('./server/jobs/check-tenant-membership');
['startTenantMembershipCheckJob','stopTenantMembershipCheckJob','runOnce'].forEach(k => {
  console.log((typeof j[k] === 'function' ? 'OK' : 'MISSING')+' export: '+k);
});
"

# 3. Server lifecycle wiring
grep -n "startTenantMembershipCheckJob" server/uptime-kuma-server.js && grep -n "stopTenantMembershipCheckJob" server/uptime-kuma-server.js

# 4. New test file exists and registers the expected test names
for name in login switchTenant logout "invalid tenant" "force-logout on removal"; do
  grep -qE "test\(\s*[\"'\''].+$name" test/backend-test/test-tenant-auth.js && echo "OK test: $name" || echo "MISSING test: $name"
done

# 5. Run the new test suite
node --test test/backend-test/test-tenant-auth.js

# 6. Regression — full backend suite
npm run test-backend 2>&1 | tail -40

# 7. i18n key added
grep -q '"forceLogoutTenant"' src/lang/en.json && echo "OK i18n key" || echo "MISSING i18n key"

# 8. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/jobs/check-tenant-membership\.js|server/uptime-kuma-server\.js|test/backend-test/test-tenant-auth\.js|src/lang/en\.json)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Security lead / Uptime Kuma maintainer — **this is the final Phase G2 signoff**. Specifically confirms:
- (a) the force-logout job cannot be DoS'd into disconnecting valid users (i.e., a transient `tenant_user` query miss due to a race during the user switching tenants does not wrongly force-logout — the job must tolerate in-flight switches; the simplest approach is to re-check the membership once more on the next tick before disconnecting, or to skip sockets whose socket handshake is younger than one tick interval),
- (b) the invalid-tenant path cannot be used to leak another tenant's data (either the strict-reject or fallback path is implemented and tested exactly as task-09's spec dictates; ambiguous spec → blocker),
- (c) the server shuts down cleanly with the job active (no hung timers),
- (d) all six integration test cases pass deterministically (no flake on the force-logout timing — `runOnce` is the synchronous path; the timed-tick form is exercised separately if at all),
- (e) existing tests still pass (no regression).

Only after reviewer signoff, append the coordinator-status block and close Phase G2.

## Explicit out-of-scope

- **Do not** add audit-log persistence for the force-logout events — G9 owns audit logging. The `"forceLogoutTenant"` emit is the hook; persistence is later.
- **Do not** implement the rate-limiter-per-tenant — G9.
- **Do not** write the G4 repository query layer — the integration tests verify the contract surface; G4 will rewrite the underlying queries.
- **Do not** extend the test suite with cross-tenant IDOR cases that read another tenant's `monitor` via direct socket — IDOR coverage is the G4/G11 cross-tenant-leak test, not G2 (G2 only proves tenant-context propagation; G4 enforces filtering).
- **Do not** add a Vue UI for the force-logout message — that is G7 (UI renders the `forceLogoutTenant` event the client already receives here).
- **Do not** add Prometheus metrics for the job — G5/G9 own metrics; the emit/disconnect is the surface, metrics are later.
- **Do not** modify the existing `disconnectAllSocketClients(userID)` for password reset — only the new tenant-scoped variant applies to this job.
- **Do not** change the job interval to be configurable from the database (`settings` table) — env var only; DB-driven config belongs to a later ops pass (G9/G10).

## Coordinator status
- Status: completed
- Completed by: Oracle (CTO)
- Completed at: 2026-08-25T11:47:02+07:00
- Verification: Verified against master history — PR #32 merged squash as 79285d20 ("feat(G2): tenant-membership watchdog job lifecycle + auth/force-logout integration suite"); `git show --stat` confirms exactly this task's owned file set: `server/jobs/check-tenant-membership.js` (new), `server/uptime-kuma-server.js` (lifecycle hooks only, +31), `src/lang/en.json` (`forceLogoutTenant` i18n), `test/backend-test/test-tenant-auth.js` (integration suite, new). Header Status stamp back-synced from `todo`; block retro-stamped during KUM-163 hygiene pass (block was omitted when the phase closed).
- Commit or artifact reference: PR #32 → master 79285d20
