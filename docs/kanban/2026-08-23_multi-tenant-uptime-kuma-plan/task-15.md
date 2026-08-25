# Task G3.15 — HTTP API Router RBAC Enforcement Sweep

**Phase:** G3 — RBAC (Role-Based Access Control)
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Backend / Express lead / Uptime Kuma maintainer

## Objective

Mirror `task-14`'s socket-side enforcement sweep on the HTTP `/api` surface so every business route is RBAC-gated with the same matrix. The HTTP side is smaller than the socket side (Uptime Kuma is Socket.IO-dominant), but the existing `/api/*` endpoints (`/api/push/:pushToken`, `/api/entry-page`, `/api/badge/:id/status`, `/api/status-page/...`, the new `POST /api/switch-tenant` from G2 `task-10`, plus any tenant-admin-only HTTP helper) must align with the matrix from `task-13`.

Critically, the **public** `/api/push/:pushToken` and `/api/entry-page` routes must remain auth-free (already exempted from G2 `task-10`'s `requireTenantContext()`).

## Prerequisites/dependencies

- **Task G3.13** reviewed and approved — `requireRole(...roles)`, `requirePermission(permission)`, `requireSuperAdmin()`, `PERMISSIONS` enum.
- **Task G2.10** approved — `resolveTenant()` sets `req.user.tenantId` and `req.user.role` on every guarded `/api` route; `requireTenantContext()` is mounted on the API router, with `/api/push/*`, `/api/entry-page`, `/metrics` exempted.
- **Task G3.14** approved OR running in parallel — this task and `task-14` can run in parallel because their file sets are disjoint (`server/routers/` vs `server/socket-handlers/`), and both consume `task-13`'s frozen matrix only, not each other's output. But starting this task before `task-13` is unapproved is a blocker.
- **If `task-13` is incomplete:** stop, report the blocker, do not enforce an unverified matrix.

## Owner / recommended agent profile

**Express router maintainer** — fluent with the project's `server/routers/api-router.js` and `server/routers/status-page-router.js`, the `allowDevAllOrigin` / `sendHttpError` patterns, and the API-key `basicAuth` authorizer. Must execute a mechanical per-route gating sweep without changing payload shapes or route paths.

## Exact files and artifacts to create or modify

1. **Modify** `server/routers/api-router.js` — for every business route, mount the corresponding `requirePermission(...)` (or `requireRole(...)` where a full role is the cleaner gate). Touch only the route handler mount; do not refactor handler bodies.
2. **Modify** `server/routers/status-page-router.js` — the authenticated-editor path (`/api/status-page/save` style) gets `requirePermission(PERMISSIONS.STATUS_PAGE_UPDATE)`; the public-status-page read paths are **public** (no auth, no `/api` mount on the guarded router — leave them as G2 left them).
3. **No other file** — `task-13` ships the middleware; this task mounts it. No new files; no socket handler changes (those are `task-14`).

## Concrete implementation steps

1. Re-read `docs/kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-13.md`'s frozen matrix and `task-10`'s exemption list (`/api/push`, `/api/entry-page`, `/metrics` are NOT guarded by `requireTenantContext()`).
2. Enumerate every route in `api-router.js` by grepping `router\.(get|post|all|put|delete)\(\s*["']`.
3. For each route:
   - **Public, auth-free routes** (`/api/push/:pushToken`, `/api/entry-page`, `/api/badge/:id/status`, `/metrics`) — already exempted from tenant context by `task-10`. Add no RBAC middleware here. They are intentionally public. Annotate with `// RBAC: public, no auth` for visibility.
   - **Authenticated business routes** — already go through G2's guarded apiRouter mount (which has `requireTenantContext()` applied). Add `requirePermission(permission)` per route:
     - `GET /api/switch-tenant` (added by G2 task-10; actually it was `POST`) → membership-checked inside the handler already; **no role gate** — switching is open to all authenticated members of the new tenant (consistent with `task-14`'s `switchTenant` exemption). Annotate `// RBAC: membership, not role`.
     - `get`/`post`/`put`/`delete` on `/api/status-page/...` editor paths → `requirePermission(PERMISSIONS.STATUS_PAGE_UPDATE)` for save, `STATUS_PAGE_DELETE` for delete, `STATUS_PAGE_CREATE` for create. Read of dashboard list → `STATUS_PAGE_READ`.
     - Any `/api/proxy`/`/api/docker-host`/`/api/api-key` editor route — match the corresponding `PERMISSIONS.PROXY_MANAGE` / `DOCKER_HOST_MANAGE` / `API_KEY_MANAGE`. Read routes → viewer+ default (no additional gate beyond auth+tenant).
     - Any `/api/monitor`/`/api/heartbeat` route — match `PERMISSIONS.MONITOR_CREATE`/`UPDATE`/`DELETE`/`READ` per verb.
4. Express middleware composition is `router.post("/foo", requirePermission(PERMISSIONS.FOO_CREATE), handler)`. Insert `requirePermission(...)` **as the first route-level middleware** — after the router-level auth (api-key basicAuth / user bearer) and after G2's router-level `requireTenantContext()` (which runs before any route handler). RBAC failure must be a clear 403 with `TranslatableError("forbiddenPermission" | "forbiddenRole")` — use `sendHttpError` already in the repo to render the error consistently with the existing 400s.
5. **Status-page public paths:** the `status-page-router.js` mounts status pages on `/status/:slug` and the custom-domain root. These are intentionally public (no auth). Do not mount any RBAC middleware on them. The public viewer doesn't have a role; the G2 resolver resolves the tenant only. Annotate `// RBAC: public, no auth` for reviewers.
6. **Do not** change the `basicAuth` authorizer signature — keep the existing API-key path. The new `bearerAuth` (if G2 introduced one) and RBAC layer cleanly: bearerAuth authenticates → `resolveTenant` sets `req.user.role` → `requirePermission` gates.
7. i18n keys `forbiddenRole` and `forbiddenPermission` already ship in `task-13` — this task adds no new keys.
8. JSDoc on any local helper (none expected). `.eslintrc.js` style.

## Interfaces/contracts and integration points

- **Upstream consumer (within G3):** `task-13` ships the middleware; this task mounts it.
- **Downstream consumer (within G3):** `task-16` (test suite) hits the HTTP routes to assert viewer→403 / tenant_admin→200 for each mutation verb.
- **Downstream consumers (later phases):**
  - G4 (Repository) — does not gate HTTP routes; G4 reads `req.user.tenantId` (set by G2) to inject into queries. RBAC and Repository layers compose: `requirePermission` (HTTP) → handler → repository (tenant-injected query).
  - G9 (Audit log) — 403 responses are candidate audit entries; G9 will hook the Express error boundary to write the row. This task does not write the audit row.
- **Behavioral parity contract:**
  - Route paths unchanged.
  - Payload shapes unchanged.
  - Default-tenant admin (legacy single-tenant) retains all capabilities (matrix subset invariant).
  - Public routes remain public — backward compat with the existing push-token / badge / public-status-page consumers.

## Acceptance criteria

- [ ] Every business route in `server/routers/api-router.js` and `server/routers/status-page-router.js` either (a) has a `requirePermission(...)`/`requireRole(...)` mount matching the matrix, or (b) is annotated `// RBAC: public, no auth` or `// RBAC: membership, not role` for the explicit-read-and-self-service exemptions.
- [ ] `/api/push/:pushToken`, `/api/entry-page`, `/api/badge/:id/status`, `/metrics` remain auth-free and tenant-guard-free.
- [ ] `POST /api/switch-tenant` is open to all authenticated members of the target tenant — **no role gate**, only the membership check already in the handler.
- [ ] Any status-page **editor** path is gated with `requirePermission(PERMISSIONS.STATUS_PAGE_UPDATE)` (or `CREATE`/`DELETE` per verb).
- [ ] Any status-page **public** path remains ungated.
- [ ] Default-tenant admin (single-tenant install) can still call every authenticated route — verified by existing `test/backend-test/` regression (the admin has `tenant_admin` role per G1; all matrix gates pass).
- [ ] A synthesized `viewer` calling a tenant_admin-only HTTP route gets `403` with `TranslatableError("forbiddenPermission")`. (Manual smoke OK; full matrix is `task-16`.)
- [ ] `npm run lint` passes on every modified file.
- [ ] No changes outside `server/routers/api-router.js`, `server/routers/status-page-router.js`. No new files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/routers/api-router.js server/routers/status-page-router.js

# 2. Enumerate routes vs RBAC annotations
npx eslint --print-config server/routers/api-router.js >/dev/null && echo "config OK"
grep -nE 'router\.(get|post|all|put|delete)\(' server/routers/api-router.js server/routers/status-page-router.js | wc -l
echo "↑ total routes; compare against the count of requirePermission mounts + RBAC annotations"
grep -cE 'requirePermission\(|requireRole\(|RBAC:' server/routers/api-router.js server/routers/status-page-router.js

# 3. Public routes still exempt — should NOT appear with requirePermission
grep -nE 'api/push|api/entry-page|/metrics|/api/badge' server/routers/api-router.js | grep requirePermission && echo 'VIOLATION: public route got RBAC gate' || echo 'OK: public routes ungated'

# 4. switch-tenant explicit exemption
grep -nE 'switch-tenant' server/routers/api-router.js && grep -A2 'switch-tenant' server/routers/api-router.js | grep -q 'RBAC: membership' && echo 'OK: switch annotated' || echo 'WARN: switch-tenant missing annotation'

# 5. Regression
npm run test-backend 2>&1 | tail -40

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/routers/api-router\.js|server/routers/status-page-router\.js)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Backend / Express lead / Uptime Kuma maintainer. Specifically confirms:
- (a) every business route has either `requirePermission`/`requireRole` or a documented exemption (public, self-service, membership),
- (b) public push-token, badge, and entry-page routes remain auth-free (no regression in Uptime Kuma's existing toolchain integrations),
- (c) `POST /api/switch-tenant` is correctly NOT role-gated (consistent with `task-14`'s socket-side `switchTenant` exemption),
- (d) the default-tenant admin — i.e., the legacy single-tenant install — still has every capability the matrix requires (backward compat),
- (e) the matrix matches `task-13` exactly — no invented permission constants.

## Explicit out-of-scope

- **Do not** change the RBAC matrix or middleware — that is `task-13`.
- **Do not** touch socket handlers — that is `task-14`.
- **Do not** write the G3 acceptance-test suite — that is `task-16`.
- **Do not** add new endpoints — only mount `requirePermission` on existing ones.
- **Do not** change the existing `basicAuth`/`bearerAuth` authorizer signatures.
- **Do not** add quota or rate-limit-per-tenant middleware — G5/G9 own that.
- **Do not** rewrite the public status page router beyond annotations — G6 owns its routing/SSL wizard; this task only ensures it is *not* accidentally gated.
- **Do not** add audit-log writes — G9 hooks the 403 boundary; this task leaves the boundary clean (just `TranslatableError`).
- **Do not** add resource-owner checks ("only the route can edit its own monitor") — G4 repository layer owns those.
- **Do not** make `/metrics` role-gated — it is intentionally public for Prometheus scraping; tenancy there is enforced by the Prometheus exporter's label, not by HTTP auth (consistent with the existing design).

## Coordinator status
- Status: completed
- Completed by: Oracle (CTO)
- Completed at: 2026-08-25T16:16:59+07:00
- Verification: Verified against master history — PR #38 merged squash as 8ec6aca9 ("feat(G3.15): HTTP API router RBAC disposition sweep"); `git show --stat` confirms exactly this task's owned file set: `server/routers/api-router.js` (+38) and `server/routers/status-page-router.js` (+18), public/auth-free routes left ungated per spec. Header Status stamp back-synced from `todo`; block retro-stamped during KUM-163 hygiene pass (block was omitted when the phase closed).
- Commit or artifact reference: PR #38 → master 8ec6aca9
