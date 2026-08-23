# Kanban: Multi-Tenant Uptime Kuma Plan

**Plan source:** [`docs/plans/multi_tenant_uptime_kuma_plan.md`](../../plans/multi_tenant_uptime_kuma_plan.md)

**Created:** 2026-08-23

**Phased execution:** This kanban is delivered **one phase at a time**. Earlier batches covered **Phases G0, G1, G2, G3, G4, G5**. This batch adds **Phase G6 (Status Page Multi-Tenant)** only. Phases G7 → G12 will be added in later batches after G6's Definition of Done is met and verified.

## Phase G0 — Foundation (Survey & Design)

Phase G0 produces **research and design artifacts only** — no production code is modified in this phase. All output lives under `docs/`.

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-01.md` | Codebase & Database Schema Survey | Codebase investigator | — | `docs/architecture/survey/` |
| `task-02.md` | Architecture Decision Records (ADRs) | Backend architect | task-01 | `docs/adr/` |
| `task-03.md` | Target Architecture Synthesis | System designer / tech lead | task-01, task-02 | `docs/architecture/` |

### Dependency waves

```
G0.task-01 ─┬─→ G0.task-02 ─┐
            └─→ G0.task-03 ←┘  (task-03 requires both 01 and 02)
```

- **Wave 1:** `task-01` (alone).
- **Wave 2:** `task-02` (after `task-01` is reviewed and approved).
- **Wave 3:** `task-03` (after `task-01` and `task-02` are approved).

There is **no parallelism within G0**: each task feeds the next, and all three write to disjoint but interdependent documentation contracts.

### Phase G0 Definition of Done (from plan)

- Team signs off on the target architecture.
- ADRs are committed under `docs/adr/`.
- ERD "AS-IS" and "TO-BE" diagrams exist.
- Risk & mitigation plan exists.
- File/module modification list exists.

## Phase G1 — Data Model & Migration

G1 implements the data layer for multi-tenancy against the contract produced by G0 (`docs/architecture/migration-contract.md` + `ADR-0001`/`ADR-0002`). All work is confined to **database migrations + RedBean model relationships** — no HTTP/socket/tenant-context logic here (that is G2).

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-04.md` | Tenant Schema Foundation (tenant / tenant_user / tenant_invitation) | Migration engineer (database) | G0 fully approved (ADR-0001, ADR-0002, `migration-contract.md`) | `db/knex_migrations/`, `server/model/` |
| `task-05.md` | tenant_id Columns + Composite Indexes on Existing Tables | Migration engineer (database) | task-04 | `db/knex_migrations/`, `db/knex_init_db.js` (comment update only) |
| `task-06.md` | Default-Tenant Seeding & Backward-Compatible Backfill | Migration engineer (database) | task-04, task-05 | `db/knex_migrations/`, `server/setup-database.js` |
| `task-07.md` | Seed Script for 3 Demo Tenants (Dev/Staging Only) | Farmer/dev-experience engineer | task-04, task-05, task-06 | `db/seed/`, `extra/` |
| `task-08.md` | Model Relationships + Migration Tests (up/down) | Backend engineer (redbean-node) | task-04, task-05, task-06 | `server/model/`, `test/backend-test/` |

### Dependency waves

```
G1.task-04 ─┬→ G1.task-05 ─┬→ G1.task-06 ─┬→ G1.task-07   (task-07 needs 04/05/06)
            │              │              ├→ G1.task-08   (task-08 needs 04/05/06)
            └──────────────┴──────────────┘
```

- **Wave 1 (solo):** `task-04` — defines the `tenant` root; nothing else can begin until `tenant` exists because every other task references `tenant_id`.
- **Wave 2 (solo):** `task-05` — adds `tenant_id` columns to existing tables (depends on `tenant` existing as a FK target).
- **Wave 3 (solo):** `task-06` — backfills existing data into a default tenant (depends on columns from 05 being present on every table).
- **Wave 4 (parallelizable pair):** `task-07` (seed/demo) and `task-08` (model wiring + tests) **can run in parallel** because:
  - Their file ownership sets are disjoint: `task-07` writes only `db/seed/` + `extra/`; `task-08` writes `server/model/*.js` + `test/backend-test/test-tenant-migration.js`.
  - Both consume the **same contract** (the schema from 04/05/06 already merged), not each other's outputs.
  - But only after 04, 05, 06 are reviewed and approved. No earlier start.

Total: **5 tasks**, single execution stream until Wave 4 where the final two run in parallel.

### Phase G1 Definition of Done (from plan)

- Migration runs cleanly on an **empty DB**.
- Migration runs cleanly on a **DB with existing data** (no loss).
- Rollback (`exports.down`) does **not** lose existing data.
- Seed for 3 demo tenants (Acme, XYZ, 123) available in dev/staging.
- ERD updated — produced in `task-08` by recording the realized schema reference. G0 already owns the static TO-BE ERD; `task-08` only verifies the realized schema matches it.

### G1 constraints preserved from the plan

- Backward compatible: existing single-tenant deployments must keep working — the default tenant must absorb all pre-migration rows.
- Knex filename format `YYYY-MM-DD-HHmm-description.js` enforced by `extra/check-knex-filenames.mjs`; all migrations must use today's date `2026-08-23-0000-` (or `0001-`, etc.) prefix.
- Knex migration rules (`db/knex_migrations/README.md`): every table needs an `id` primary key; avoid native SQL syntax — use Knex methods; both SQLite and MariaDB must work.
- No new code in `db/knex_init_db.js` (per its header warning) — only the inline comment in `task-05` is permitted because init_db stays in sync with new-table baseline for fresh MariaDB installs.
- Production code stays untouched outside `server/model/`, `server/setup-database.js`, migrations, seed.
- Don't touch billing, RBAC, repository layer, status page, frontend — those belong to G2+, G3, G4, G6, G7.

## Phase G2 — Authentication & Tenant Context

G2 ensures every business route and socket event knows which tenant it belongs to. It refactors the login flow to return the user's tenant list, introduces the `resolveTenant()` middleware chain (subdomain → custom domain → `X-Tenant-ID` header → session/JWT claim, per ADR-0003), reshapes the Socket.IO room scheme to be `(tenant_id, user_id)`-partitioned, and handles the "user removed from tenant while online → force logout" edge case. **No RBAC enforcement here** — G3 owns role/permission decisions; G2 only establishes *which* tenant context applies.

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-09.md` | JWT claims + tenant picker on login | Auth engineer (backend) | G1 fully approved (`task-04`, `task-05`, `task-06`, `task-08`) | `server/model/user.js`, `server/auth.js`, `server/server.js` |
| `task-10.md` | `resolveTenant()` HTTP middleware + tenant-guard | Backend engineer (Express) | task-09 | `server/middleware/` (new), `server/server.js`, `server/routers/api-router.js`, `server/routers/status-page-router.js` |
| `task-11.md` | Socket.IO tenant-context wiring + room reshaping | Realtime/socket engineer | task-09, task-10 | `server/socket-handlers/*.js`, `server/client.js`, `server/util-server.js`, `server/uptime-kuma-server.js` |
| `task-12.md` | Force-logout on tenant removal + integration tests | Backend engineer (security) | task-09, task-10, task-11 | `server/jobs/`, `server/uptime-kuma-server.js`, `test/backend-test/test-tenant-auth.js` |

### Dependency waves

```
G2.task-09 ─┬→ G2.task-10 ─┬→ G2.task-11 ──┐
            │              │              ├→ G2.task-12  (needs 09/10/11)
            └──────────────┴──────────────┘
```

- **Wave 1 (solo):** `task-09` — JWT claims + tenant-picker post-login (defines the tenant-context shape every later task consumes).
- **Wave 2 (solo):** `task-10` — `resolveTenant()` HTTP middleware + `requireTenantContext()` guard.
- **Wave 3 (solo):** `task-11` — Socket.IO room keys + tenant-partitioned emits.
- **Wave 4 (solo):** `task-12` — force-logout + integration tests (validates the full chain end-to-end).

No parallelism within G2: every task extends the contract of the previous one. The four tasks together satisfy the plan's G2 "Definition of Done": no business logic runs without tenant context; login/switch/logout/invalid-tenant flows are tested.

### Phase G2 Definition of Done (from plan)

- No route with business logic runs without tenant context (enforced by `requireTenantContext()`).
- Tests cover: login, switch tenant, logout, invalid tenant.
- Socket.IO rooms partitioned by `tenant_id` — clients only receive events for their tenant.
- Refresh token on tenant switch is implemented.
- Forced logout when a user is removed from a tenant while online.

### G2 constraints preserved from the plan

- **Tenant resolution priority order (ADR-0003):** subdomain → custom domain → `X-Tenant-ID` header → session/JWT claim. Implement exactly this order; do not reorder.
- **Trust proxy:** honor `Settings.get("trustProxy")` already used in `api-router.js` (subdomain/customer-domain resolution must respect `X-Forwarded-Host`).
- **Backward compatible:** a single-tenant deployment (default tenant from `task-06`) must continue to log in and operate without an explicit tenant selection step.
- **No RBAC enforcement in this phase:** the `role` claim is set on the token but G3 is what gates endpoints by role. G2 must not reject based on role.
- **No frontend changes yet** beyond the minimal tenant-picker payload returned over the wire (the UI onboarding/switcher belongs to G7). G2 returns the data; G7 renders it.
- **Redis adapter** for multi-instance Socket.IO is deferred to G10 (DevOps/Golden Image). G2 rooms work in-process; the room-key contract is what G10 will later make cluster-safe.
- **Status page public routing** (custom domain → tenant) is partially landed here (the resolver) but the full SSL/CNAME wizard is G6.

## Phase G3 — RBAC (Role-Based Access Control)

G3 builds the reusable role/permission matrix and threads it through every business endpoint — Socket.IO (`task-14`) and HTTP (`task-15`) — so no business logic runs without a role-permission check beyond the documented self-service exemptions (`changePassword`, 2FA, `switchTenant`, login/logout, public status page, push token, badge, metrics). The matrix is **exactly the plan's four roles**: Super Admin → Tenant Admin → Member → Viewer, with subset invariants `VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN`. Resource-level (owner-based) checks are **not** in G3 — those are G4's repository-layer responsibility; G3 RBAC is role+permission only.

G3 ships **no audit-log writes** (G9 owns that). `task-16` adds the `audit-hook.js` surface with a frozen signature so G9's later swap-in is mechanical, mirroring the precedent `task-12` set for the force-logout hook.

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-13.md` | RBAC Foundation (roles / permissions / policy / middleware / socket helpers) | Backend security architect | G2 fully approved (09/10/11/12) + G1 (04/06/08) | `server/rbac/`, `server/middleware/require-rbac.js`, `server/server.js` (single `afterLogin` hook), `src/lang/en.json`, `package.json` |
| `task-14.md` | Socket-Handler RBAC Enforcement Sweep | Socket-handler maintainer | task-13 | `server/socket-handlers/*.js`, `server/server.js` (inline socket handlers only) |
| `task-15.md` | HTTP API Router RBAC Enforcement Sweep | Express router maintainer | task-13 (task-14 may run in parallel — disjoint file set) | `server/routers/api-router.js`, `server/routers/status-page-router.js` |
| `task-16.md` | RBAC Acceptance Test Suite + Audit-Log Hook Surface (G9) | Backend test engineer (security) | task-13, task-14, task-15 + G2 task-12 harness + G1 task-07 demo seed | `test/backend-test/test-rbac.js`, `server/rbac/audit-hook.js`, `server/rbac/socket-rbac.js` (export addition only) |

### Dependency waves

```
G3.task-13 ─┬→ G3.task-14 ─┐
            └→ G3.task-15 ─┴→ G3.task-16  (needs 13/14/15)
```

- **Wave 1 (solo):** `task-13` — freezes the role/permission matrix and ships the middleware + socket helpers. Nothing else can begin until the matrix is approved.
- **Wave 2 (parallelizable pair):** `task-14` (Socket.IO handlers) and `task-15` (HTTP routes) **can run in parallel** because:
  - Their file ownership sets are disjoint: `task-14` writes only `server/socket-handlers/*.js` + the inline `socket.on(...)` block in `server/server.js`; `task-15` writes only `server/routers/api-router.js` + `server/routers/status-page-router.js`.
  - Both consume the **same frozen matrix** from `task-13`, not each other's output. No cross-task contract handoff.
  - Both must start **only after `task-13` is reviewed and approved** — a moving matrix invalidates both.
- **Wave 3 (solo):** `task-16` (test suite + audit hook) — needs 13/14/15 final-gated.

Total: **4 tasks**, single execution stream until Wave 2 where 14/15 run in parallel.

### Phase G3 Definition of Done (from plan)

- 100% of business endpoints are protected by RBAC (every mutation gated; documented exemptions are read or self-service only).
- No escalation path: a Member/Viewer cannot elevate their own `tenant_user.role`.
- The four-role matrix matches the plan's table (Super Admin / Tenant Admin / Member / Viewer) with subset invariants.
- `npm run test-backend` passes on SQLite with the new RBAC test suite and zero regression.

### G3 constraints preserved from the plan

- **Roles exactly as the plan enumerates:** `super_admin`, `tenant_admin`, `member`, `viewer` — the values must match G1 task-04's `tenant_user.role` column. No 5th role; a missing capability is an RFC, not a silent extension.
- **CASL isomorphic policy** (per plan: "CASL — isomorphic – dùng cả BE/FE"): `task-13` ships the Node-side `buildAbilityFor(role)`; G7 will reuse the same module in the browser. The frozen surface `{ can, canAny }` is what G7 needs — no browser-specific shape required.
- **Resource-level (owner-based) checks deferred to G4** (plan implies this implicitly — the plan's G4 task is "Base Repository tự động inject `tenant_id`" and "Test IDOR cross-tenant"). G3 RBAC is role+permission only.
- **Audit log is G9, not G3** — `task-16` ships only the `audit-hook.js` surface with `// TODO(G9)` marking the swap point; no `audit_log` table or row write happens in G3 (precedent: `task-12` left the `"forceLogoutTenant"` emit as a hook for G9).
- **Self-service exemptions are deliberate** (not omissions): 2FA, `changePassword`, `switchTenant`, login/logout/setup are user-level, available to all roles. `switchTenant` is gated by membership (G2 task-11), not by role (per `task-14` step 11 and `task-15` step 4).
- **Public routes remain auth-free** (`/api/push/:pushToken`, `/api/entry-page`, `/api/badge/:id/status`, `/metrics`) — backward compat with Uptime Kuma's existing toolchain; tenancy on push tokens is enforced by the monitor's `tenant_id` (G1 task-05), not HTTP auth.
- **Backward compatible:** the default-tenant `tenant_admin` (legacy single-tenant admin from G1 task-06) retains every capability the matrix requires — no new restriction for single-tenant installs.
- **No frontend UI gating yet** — G7 owns the Vue ability-based UI; G3 ships the data and the contract only.
- **No quota enforcement** (per plan "số monitor tối đa") — G5/G8 own quota; G3 freezes role-permission RBAC only.

## Phase G4 — Repository / Query Layer

G4 wraps `redbean-node` (`R.findOne/find/exec/dispense`) with a **tenant-safe query layer** that injects `tenant_id` into every business query, plus a static-analysis ESLint rule (`require-tenant-scope`) that catches future regressions. The existing single-tenant codebase scopes queries by `user_id`; G4 supplements that with `tenant_id` (tenant-isolation, defense-in-depth alongside ownership). The monitoring engine's per-tenant tick loop (G5) and the public status page slug resolver (G6) consume this wrapper.

G4 ships **no Redis cache adapter** (that's G10) but freezes the cache-key namespace contract (`tenant:${tenantId}:${key}`) so G10's adapter procurement is mechanical. G4 ships **no audit-log writes** (G9, per the precedent `task-12` and `task-16` set).

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-17.md` | Base Repository + Tenant-Safe Query Wrapper (Contract Originator) | Backend data-access architect | G3 fully approved (13–16) + G1 (04/05/06/08) | `server/repository/`, `.eslintrc.js`, `test/backend-test/test-repo-tenant.js` (smoke), `package.json` (if `@eslint/plugin-kit` devDep) |
| `task-18.md` | Socket-Handler Call-Site Rewrite to Tenant-Safe Queries | Socket-handler maintainer | task-17 (task-19 may run in parallel — disjoint file set) | `server/socket-handlers/*.js`, `server/client.js`, `server/server.js` (inline socket handlers only), `.eslintrc.js` |
| `task-19.md` | Model + UptimeKumaServer Method Rewrite to Tenant-Safe Queries | Backend data-access engineer | task-17 (task-18 may run in parallel — disjoint file set) | `server/model/*.js`, `server/uptime-kuma-server.js`, `server/notification.js`, `server/docker.js`, `server/proxy.js`, `server/remote-browser.js`, `.eslintrc.js` |
| `task-20.md` | Cross-Tenant IDOR Test Suite + Cache-Key Namespace Adoption | Backend test engineer (security) | task-17, task-18, task-19 + G2 task-12 harness + G1 task-07 seed + G3 task-16 patterns | `test/backend-test/test-tenant-idor.js`, `server/notification.js`, `server/uptime-calculator.js`, `server/prometheus.js` (cache key adoption only) |

### Dependency waves

```
G4.task-17 ─┬→ G4.task-18 ─┐
            └→ G4.task-19 ─┴→ G4.task-20  (needs 17/18/19)
```

- **Wave 1 (solo):** `task-17` — freezes the wrapper signatures and cache-namespace contract. Nothing else can start until the wrapper is approved.
- **Wave 2 (parallelizable pair):** `task-18` (socket-handler call sites) and `task-19` (model + uptime-kuma-server methods) **can run in parallel** because:
  - Their file ownership sets are disjoint: `task-18` writes only `server/socket-handlers/*.js` + `server/client.js` + the inline socket block in `server/server.js`; `task-19` writes `server/model/*.js` + `server/uptime-kuma-server.js` + the between-modules (`server/notification.js`, `server/docker.js`, `server/proxy.js`, `server/remote-browser.js`).
  - Both consume the **same frozen wrapper** from `task-17`, not each other's output. The shared contract is the wrapper signature; the call site ↔ model parameter threading is documented in both task specs so they meet in the middle without coordination.
  - Both must start **only after `task-17` is reviewed and approved** — a moving wrapper signature invalidates both.
- **Wave 3 (solo):** `task-20` (IDOR tests + cache-key adoption) — needs 17/18/19 fully migrated so the suite tests the production query path, not a stub.

Total: **4 tasks**, single execution stream until Wave 2 where 18/19 run in parallel.

### Phase G4 Definition of Done (from plan)

- Tenant-safe ORM layer (every query filters by `tenant_id` via the wrapper, with documented exemptions for cross-tenant system config: `setting`, `user`).
- Test suite against cross-tenant leak (IDOR) passes 100%.
- Custom ESLint rule (`uptime-kuma/require-tenant-scope`) catches unscoped `R.findOne/R.find/R.exec/R.findAll` in new code.
- Cache key namespace prefix `tenant:${tenantId}:` adopted wherever a tenant-owned key was hand-written (Redis adapter procurement belongs to G10).
- Backward compatible: the legacy single-tenant install (default-tenant admin) sees zero regressions.

### G4 constraints preserved from the plan

- **Standardization** (per plan: "Mọi query DB đều bắt buộc filter theo `tenant_id`. Không có ngoại lệ.") — wrapper injects `tenant_id`; documented exemptions (`setting`, `user` global, anonymous status-page read) carry an inline rationale and an `eslint-disable` directive, never a silent bypass.
- **Zero Trust cross-tenant** (per plan: "Middleware chặn từ HTTP layer, repository layer, và socket layer") — G4 is the repository-layer enforcement; G2 covered HTTP + socket layers; G3 covered the role dimension. The three layers stack: G3 role gate → G4 tenant filter → G2 tenant-context resolver.
- **Knex/RedBean conformance** (per plan): the wrapper layers on top of `redbean-node` rather than replacing it (least-surprise for the existing handlers; the plan's "Prisma/Sequelize/Knex" alternatives are options, not requirements; the codebase choice is RedBean).
- **Resource-level (owner-based) checks are out of scope** — the plan's Member-tier "quản lý notification của mình" is enforced socially by retaining the `user_id` filter alongside `tenant_id`, not via a separate RBAC permission per resource. Documented in `task-17`'s out-of-scope.
- **Child-table schema (heartbeat / stat_* / monitor_tag / monitor_notification / monitor_tls_info / incident)** — FK-anchored to `monitor`; isolation via the `WHERE monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)` subquery pattern (not a redundant `tenant_id` column); G1 owns the schema, G4 doesn't add columns.
- **Audit log is G9, not G4** — `task-20` adopts the cache-key namespace; `task-16` left the audit hook surface; G4 wraps queries with the plain wrapper variants, not the audited variants.
- **No Redis adapter in G4** — `task-17` freezes the cache-key namespace contract; `task-20` adopts it where the codebase hand-writes keys; G10 owns the adapter procurement.
- **Backward compatible** — the default-tenant admin's existing install works because G1's `task-06` backfill assigned every legacy row to `tenant_id = default`; G4's wrapper queries match `(user_id, tenant_id=default)` and return the same result set.
- **No frontend changes** — G7 owns the UI; G4 ships data-layer isolation only.

## Phase G5 — Monitoring Engine Multi-Tenant

G5 refactors the in-process monitoring engine (scheduler, heartbeat writer, notification dispatcher) to be tenant-aware. The flat `monitorList = {}` map becomes `monitorListByTenant = {}`; `UptimeCalculator.list` becomes `listByTenant`; `startMonitors()` iterates tenants; `startMonitor()` adds a quota gate; heartbeats emit to `userRoom(tenantId, userID)`; notification dispatch carries tenant context; Prometheus gains `tenant_id` labels; `clearOldData` applies per-tenant retention; and `startMonitors()` batches per-tenant startup for noisy-neighbor fairness.

G5 consumes the frozen contracts from G4 (wrapper) and G2 (tenant-context, room keys). It ships **no database-driven quotas** (G8 owns that), **no Redis adapter** (G10), and **no audit-log writes** (G9).

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-21.md` | Scheduler Tenant Partitioning (Engine Core Refactor) | Backend engine architect | G4 fully approved (17–20) + G2 (09/11) + G1 (04/05/06/08) | `server/uptime-kuma-server.js`, `server/server.js`, `server/uptime-calculator.js`, `server/model/monitor.js` |
| `task-22.md` | Heartbeat Writer & Notification Dispatcher Tenant-Aware | Backend engine engineer | task-21 (task-23 may run in parallel — disjoint file set) | `server/model/monitor.js`, `server/notification.js`, `server/jobs/clear-old-data.js` |
| `task-23.md` | Quota, Rate Limiting, Prometheus, Retention & Multi-Tenant Engine Tests | Backend test engineer (security + performance) | task-21, task-22 + G4 (17–20) + G2 (09–12) + G1 (07) | `test/backend-test/test-tenant-engine.js`, `server/server.js`, `server/prometheus.js`, `server/model/monitor.js`, `server/jobs/clear-old-data.js` |

### Dependency waves

```
G5.task-21 ─┬→ G5.task-22 ─┐
            └→ G5.task-23 ─┘  (task-23 needs 21 + 22; task-22 can run in parallel with 23 only if 22's file set is merged first)
```

- **Wave 1 (solo):** `task-21` — freezes the partitioned engine data structures (`monitorListByTenant`, `UptimeCalculator.listByTenant`, `startMonitor(tenantId, ...)` signature). Nothing else can start until the engine core is approved.
- **Wave 2 (two-task waterfall):** `task-22` (heartbeat/notification path) then `task-23` (quota/metrics/tests). They share `monitor.js` as a touchpoint; `task-22` modifies `beat()` and `sendNotification`; `task-23` modifies `start()` (quota gate) and `prometheus.js`. The recommended execution order is `task-21` → `task-22` → `task-23` (apply patches sequentially on `monitor.js`). If executed in parallel, the agent for `task-23` must wait for `task-22`'s `monitor.js` changes to land before applying its own.

Total: **3 tasks**, sequential execution.

### Phase G5 Definition of Done (from plan)

- Monitoring engine is multi-tenant: scheduler loads monitors per tenant; heartbeat writer stores with tenant context; notification dispatcher carries tenant context.
- Rate limit & quota per tenant: max monitors, min check interval enforced at `startMonitor`.
- Prometheus metrics have `tenant_id` label.
- Noisy neighbor mitigation: per-tenant tick loop staggering with configurable concurrency.
- Heartbeat retention policy per tenant (hardcoded defaults by plan until G8).
- Stable with ≥ 100 tenants × 50 monitors in staging; no tenant delayed > 10% due to another tenant.
- Default-tenant backward-compat: single-tenant install works unchanged.

### G5 constraints preserved from the plan

- **Standardization** (per plan: "Mọi query DB đều bắt buộc filter theo `tenant_id`") — G4 wrapper ensures this; G5's engine queries use `findForTenant`/`execForTenant`.
- **Zero Trust cross-tenant** (per plan: "Middleware chặn từ HTTP layer, repository layer, và socket layer") — G5 adds the engine layer: the in-process scheduler never cross-pollinates monitors between tenants.
- **Horizontal Scalable** (per plan: "Không state trong process; scheduler/worker có thể chạy nhiều instance") — the tenant-partitioned map is single-process by design; G10's Redis adapter makes it cluster-safe. G5 does not break the in-process model.
- **Observability by default** (per plan: "Mọi log/metric/trace đều có label `tenant_id`") — G5 adds `tenant_id` to Prometheus labels.
- **Backward compatible** — the default-tenant admin's monitors start, heartbeat, and notify exactly as before. The `monitorList` compat getter ensures no runtime crash.
- **Quota defaults are hardcoded** (not database-driven) — G8 replaces them with Stripe/Paddle-driven quotas. The `getTenantQuota(tenantId, key)` function is the hook point.
- **No Redis adapter** — G10 owns the adapter.
- **No audit-log writes** — G9 owns audit logging.
- **No frontend changes** — G7 owns the UI.
- **No notification rate limit** — deferred to G9 (security) or G8 (billing).
- **Child-table isolation** (heartbeat, stat_*, monitor_tag, monitor_notification, monitor_tls_info, incident) — FK-anchored to `monitor`; isolation via `monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)`; G5 does not add redundant `tenant_id` columns to these tables.

## Phase G6 — Status Page Multi-Tenant

G6 refactors the status page routing, data layer, and branding to support multi-tenant isolation. It introduces a `resolveStatusPageTenant()` middleware that resolves `(tenantId, slug)` from the request via 5 resolution strategies (custom domain → subdomain → path → session/JWT → default tenant), scopes every status page data query and socket handler to the correct tenant, injects tenant-specific branding (title, description, OG tags, favicon) into SSR-rendered HTML, adds CNAME validation for custom domains, generates reverse proxy configs (Caddy/Nginx), and sets CDN-friendly `Cache-Control` headers.

G6 consumes the frozen contracts from G5 (engine), G4 (wrapper), G2 (tenant-context, room keys), and G1 (tenant tables). It ships **no actual SSL provisioning** (that's Caddy/certbot), **no CDN integration** (G10), and **no frontend UI** (G7).

| Task | Title | Owner | Prereqs | Output area |
|---|---|---|---|---|
| `task-24.md` | Status Page Tenant Resolution + Domain Mapping Refactor | Backend routing engineer | G5 fully approved (21/22/23) + G4 (17–20) + G2 (09–12) + G1 (04/05/06/08) | `server/middleware/status-page-tenant.js`, `server/model/status_page.js`, `server/routers/status-page-router.js`, `server/server.js`, `docs/architecture/status-page-routing.md` |
| `task-25.md` | Status Page Data Layer Tenant Scoping + Branding Injection | Backend data-access engineer | task-24 (task-26 may run in parallel — disjoint file set with coordination on `status_page.js`) | `server/model/status_page.js`, `server/model/group.js`, `server/model/incident.js`, `server/socket-handlers/status-page-socket-handler.js`, `server/routers/status-page-router.js` |
| `task-26.md` | Custom Domain Wizard, Reverse Proxy Config & G6 Acceptance Test Suite | Backend test engineer + DevOps engineer | task-24, task-25 + G5 (21–23) + G4 (17–20) + G2 (09–12) + G1 (07) | `server/model/status_page.js`, `server/socket-handlers/status-page-socket-handler.js`, `server/routers/status-page-router.js`, `extra/generate-caddy-config.js`, `extra/generate-nginx-config.js`, `test/backend-test/test-tenant-status-page.js`, `docs/status-page/custom-domain-setup.md` |

### Dependency waves

```
G6.task-24 ─┬→ G6.task-25 ─┐
            └→ G6.task-26 ─┘  (task-26 needs 24 + 25; task-25 can run in parallel with 26 only if 25's file set is merged first)
```

- **Wave 1 (solo):** `task-24` — freezes the `resolveStatusPageTenant` middleware, the `loadDomainMappingList()` shape `{ tenantId, slug }`, and the `handleStatusPageResponse(..., tenantId)` signature. Nothing else can start until the resolution contract is approved.
- **Wave 2 (two-task waterfall):** `task-25` (data-layer scoping + branding) then `task-26` (domain wizard + tests). They share `status_page.js` and `status-page-router.js` as touchpoints. The recommended execution order is `task-24` → `task-25` → `task-26` (apply patches sequentially). If executed in parallel, the agent for `task-26` must wait for `task-25`'s changes to land before applying its own.

Total: **3 tasks**, sequential execution.

### Phase G6 Definition of Done (from plan)

- **3 routing strategies** work end-to-end: subdomain (`acme.status.example.com`), path (`example.com/acme/status`), custom domain (`status.acme.com`).
- Custom domain resolution includes CNAME validation and proper error handling.
- Reverse proxy config (Caddy/Nginx) generated correctly for tenant-aware routing.
- Status page public routes have CDN-friendly `Cache-Control` headers.
- Tenant-specific branding (title, description, OG tags, favicon) injected into SSR HTML.
- Status page data is fully isolated — no cross-tenant data leak on any public route or socket event.
- Default-tenant backward-compat: `GET /status/default` works exactly as before.
- Custom domain wizard validated end-to-end.
- G6 acceptance test suite covers all 12 scenarios.

### G6 constraints preserved from the plan

- **3 routing strategies** (per plan: "Subdomain, Path, Custom Domain") — implemented in the resolution middleware exactly as specified.
- **Custom domain with CNAME + SSL** (per plan: "CNAME + SSL tự động qua Let's Encrypt/Caddy") — the config generator + CNAME validation enables this; actual SSL provisioning is done by Caddy/certbot outside the Node.js process.
- **Reverse proxy config** (per plan: "Caddy (auto SSL) hoặc Traefik (dynamic config), fallback Nginx + certbot") — both Caddy and Nginx config generators are provided.
- **Theme/branding riêng** (per plan: "logo, màu chủ đạo, tên công ty, favicon") — the `renderHTML()` branding injection covers title, description, OG tags, and favicon. Logo/favicon columns on `tenant` are consumed if present.
- **SEO & meta tag** (per plan: "OG image, title, description") — injected via `renderHTML()`.
- **Wizard cấu hình custom domain** (per plan: "có kiểm tra CNAME + tự động issue cert") — the `saveStatusPage` handler validates CNAME; the config generator enables auto-SSL.
- **Cache CDN-friendly** (per plan: "short TTL, revalidate on incident") — `Cache-Control` headers with `stale-while-revalidate` on HTML routes.
- **Public routes remain auth-free** — the `resolveStatusPageTenant` middleware does not require authentication; it resolves tenant from hostname/path alone.
- **No frontend changes** — G7 owns the UI (domain wizard UI, tenant switcher in status page admin).
- **No actual SSL provisioning** — the config generator ships the config; Caddy/certbot does the provisioning.
- **No CDN integration** — G10 owns this.
- **No audit-log writes** — G9 owns audit logging.

## Subsequent phases (to be added in later batches)

- ~~G1 — Data Model & Migration~~ _(delivered in earlier batch)_
- ~~G2 — Authentication & Tenant Context~~ _(delivered in earlier batch)_
- ~~G3 — RBAC~~ _(delivered in earlier batch)_
- ~~G4 — Repository / Query Layer~~ _(delivered in earlier batch)_
- ~~G5 — Monitoring Engine Multi-Tenant~~ _(delivered in earlier batch)_
- ~~G6 — Status Page Multi-Tenant~~ _(delivered in this batch)_
- G7 — UI / UX (Frontend)
- G8 — Billing & Quota (optional, SaaS only)
- G9 — Security, Observability & Hardening
- G10 — DevOps, CI/CD & Golden Image
- G11 — Testing & QA
- G12 — Documentation & Release

Phases G7 → G12 will be broken down into kanban tasks only after G6 is approved, per the user's request to deliver one phase at a time.
