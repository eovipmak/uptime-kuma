# File Impact List (Targeted Modifications, G1 → G12)

> The consolidated, authoritative list of files/modules downstream phases will modify, derived from the [G0.01 file impact map](./survey/file-impact-map.md) and promoted from "candidate" to **targeted** wherever an ADR (or a kanban task bound to one) confirms the change is needed. Entries no ADR addresses remain **unconfirmed** — they are *not* commitments and must not be treated as scope.
>
> Legend: **T** = `targeted` (ADR/kanban-confirmed), **U** = `unconfirmed` (no ADR decides yet). Phases reference the [kanban plan](../kanban/2026-08-23_multi-tenant-uptime-kuma-plan/README.md).

## Summary counts

| Status | Count | Meaning |
| --- | --- | --- |
| Targeted | 40 file groups | Change confirmed by ADR-0001..0004 or their kanban tasks |
| Unconfirmed | 24 file groups | Deferred until the owning phase breaks down (mostly frontend G7+, notification providers) |

---

## Backend models (`server/model/`, `server/*.js`)

| File(s) | AS-IS role | Status | Phases & reason |
| --- | --- | --- | --- |
| `server/model/user.js` | User bean | T | G1 task-08 (relationships); G2 task-09 (JWT claims, tenant list on login) |
| `server/model/tenant.js` *(new)* | — | T | G1 task-04: tenant root bean |
| `server/model/tenant_user.js` *(new)* | — | T | G1 task-04: membership bean + `listForUser()` helper consumed by G2 |
| `server/model/tenant_invitation.js` *(new)* | — | T | G1 task-04 |
| `server/model/refresh_token.js` *(new, G2)* | — | T | G2: rotating refresh family persistence ([ADR-0004](../adr/ADR-0004-authentication-strategy.md)) |
| `server/auth.js` | Login/2FA/API-key verification | T | G2 task-09: token issuance/validation, refresh rotation, switchTenant; apiKeyAuth gains tenant binding ([ADR-0004](../adr/ADR-0004-authentication-strategy.md)) |
| `server/model/monitor.js` | 2083-line beat loop + dispatch | T | G1 task-08 (relationships); G4 task-19 (tenant-safe queries); G5 tasks 21–23 (partitioned loop, quota gate, tenant-aware emits/notification) |
| `server/notification.js` | Dispatcher + save | T | G4 task-19 (wrapper adoption); G5 task-22 (tenant context in dispatch) |
| `server/model/status_page.js` | Slug mapping, page data | T | G4 task-19 (wrapper); G6 tasks 24–25 (tenant resolution data layer, branding injection) |
| `server/model/group.js` | Group bean | T | G4 task-19; G6 task-25 (public group scoping) |
| `server/model/incident.js` | Incident bean | T | G6 task-25 (status-page-anchored scoping) |
| `server/model/tag.js` | Tag + monitor_tag beans | T | G1 task-08 (tags become per-tenant rows per [ADR-0002](../adr/ADR-0002-isolation-model.md)); G4 task-19 |
| `server/model/maintenance.js` | Strategy logic, run() | T | G4 task-19; G5 (engine awareness of maintenance lists) |
| `server/model/proxy.js` | Proxy bean | T | G4 task-19 |
| `server/model/docker_host.js` | Docker host bean | T | G4 task-19 (plus `server/docker.js`) |
| `server/model/api_key.js` | Key bean | T | G4 task-19; key gains tenant binding via owner monitor/tenant context |
| `server/model/heartbeat.js` | Beat bean, response decode | U | No schema change (child table stays anchor-only per [ADR-0002](../adr/ADR-0002-isolation-model.md)); decode logic unchanged — revisit only if G9 changes payload handling |
| `server/uptime-calculator.js` | Stat aggregates writer/reader | T | G5 task-21 (`listByTenant` partitioning); G4 task-20 (cache-key namespace) |
| `server/uptime-kuma-server.js` | Server bootstrap, registries, monitorList | T | G2 task-11 (socket bootstrap rooms); G5 task-21 (`monitorListByTenant`) |
| `server/client.js` | Server→client emit helpers | T | G2 task-11 (tenant-partitioned emit targets); G4 task-18 |
| `server/util-server.js` | Shared server utils | T | G2 task-11 (room helper `userRoom(tenantId, userId)`) |
| `server/settings.js` | Global settings store | U | `setting` table is a documented global exemption ([ADR-0002](../adr/ADR-0002-isolation-model.md)); tenant-level settings would be a new feature needing its own decision |
| `server/prometheus.js` | Metrics export | T | G5 task-23: every metric labeled `tenant_id`; cache-key adoption |
| `server/jobs/clear-old-data.js` | Retention deletes | T | G5 task-22/23: per-tenant retention policy |
| `server/jobs/incremental-vacuum.js` | SQLite vacuum job | U | SQLite-only concern; whether multi-tenant MariaDB deployments skip it is a G10 packaging decision |

## HTTP layer

| File(s) | AS-IS role | Status | Phases & reason |
| --- | --- | --- | --- |
| `server/middleware/resolve-tenant.js` *(new, G2)* | — | T | G2 task-10: `resolveTenant()` priority chain exactly as [ADR-0003](../adr/ADR-0003-routing-and-tenant-resolution.md) |
| `server/middleware/require-tenant-context.js` *(new, G2)* | — | T | G2 task-10 guard |
| `server/middleware/require-rbac.js` *(new, G3)* | — | T | G3 task-13 |
| `server/rbac/*` *(new, G3)* | CASL policy module | T | G3 task-13: frozen 4-role matrix; reused by frontend in G7 |
| `server/routers/api-router.js` | Business API + push/badges | T | G2 task-10 (mount resolver); G3 task-15 (role sweep); G5 (push route room targeting) |
| `server/routers/status-page-router.js` | Public status-page routes | T | G2 task-10; G3 task-15; G6 tasks 24–26 (`resolveStatusPageTenant`, Cache-Control, branding) |
| `server/server.js` | Main wiring + ~30 inline socket handlers | T | G1 (none); G2 tasks 10–11 (middleware mount, socket wiring); G3 task-14 (inline handler sweep); G5 task-21/23 (startMonitors partitioning, quota hook) |

## Socket handlers (`server/socket-handlers/`)

| File(s) | AS-IS role | Status | Phases & reason |
| --- | --- | --- | --- |
| All 10 handler files (`api-key`, `chart`, `cloudflared`, `database`, `docker`, `maintenance`, `proxy`, `status-page`, plus future ones) | Event CRUD surfaces | T | G2 task-11 (room/context reshaping), G3 task-14 (role gates), G4 task-18 (tenant-safe call sites); status-page handler additionally G6 task-25 |
| `server/socket-handlers/status-page-socket-handler.js` | Incident/page admin events | T | Same as above plus G6 tasks 25–26 (CNAME wizard validation, scoped saves) |

## Data layer (`db/`)

| File(s) | AS-IS role | Status | Phases & reason |
| --- | --- | --- | --- |
| `db/knex_migrations/2026-08-23-0000-create-tenant-tables.js` *(new)* | — | T | G1 task-04 ([migration contract](./migration-contract.md)) |
| `db/knex_migrations/…-add-tenant-id-columns.js` *(new)* | — | T | G1 task-05 |
| `db/knex_migrations/…-backfill-default-tenant.js` *(new)* | — | T | G1 task-06 |
| `db/setup-database.js` (aka `server/setup-database.js` per kanban) | Install-time DB setup | T | G1 task-06 (default tenant seeding path) |
| `db/knex_init_db.js` | Fresh-install baseline | T | G1 task-05 **comment-only** update (its header forbids schema code) |
| `db/seed/*`, `extra/*` seed helpers *(new)* | — | T | G1 task-07: 3 demo tenants (Acme, XYZ, 123), dev/staging only |
| Migration engine dialect branches | Dual SQLite/MariaDB support | T | All G1 migrations stay dual-dialect per [ADR-0001](../adr/ADR-0001-database-choice.md) + repo migration rules |

## Edge & ops artifacts

| File(s) | AS-IS role | Status | Phases & reason |
| --- | --- | --- | --- |
| `extra/generate-caddy-config.js` *(new)* | Caddyfile generator | T | G6 task-26 ([ADR-0003](../adr/ADR-0003-routing-and-tenant-resolution.md) reference edge) |
| `extra/generate-nginx-config.js` *(new)* | Nginx generator | T | G6 task-26 (fallback target mandated by plan) |
| Docker/golden image, CI/CD, Redis adapter, CDN config | Packaging & infra | U | G7–G12 batches not yet broken down; G10 owns ([ADR-0003](../adr/ADR-0003-routing-and-tenant-resolution.md) defers procurement) |

## Frontend (`src/`)

> Direction is confirmed at module level — [ADR-0004](../adr/ADR-0004-authentication-strategy.md) commits the frontend to consume the shared CASL ability module, and the plan assigns tenant switcher/domain-wizard UI to G7 — but the G7 batch is not broken into tasks yet, so **every individual frontend entry below is unconfirmed at file level**.

| File(s) | AS-IS role | Status | Likely phase |
| --- | --- | --- | --- |
| `src/pages/Login.vue`, `src/components/Login.vue`, `src/pages/Setup.vue` | Auth entry points | U (G7 pending) | Tenant picker post-login (G2 ships the wire payload only) |
| `src/pages/Settings.vue`, `src/components/settings/Security.vue` | Account/security UI | U (G7 pending) | 2FA/password unchanged; tenant admin surfaces new |
| `src/mixins/socket.ts` / `.js` | Socket client lifecycle | U (G7 pending) | Room keys change server-side in G2; client join payload may need matching update |
| `src/pages/DashboardHome.vue`, `List.vue`, `Details.vue`, `EditMonitor.vue`, `ManageStatusPage.vue`, `AddStatusPage.vue`, `EditMaintenance.vue`, `ManageMaintenance.vue` | Business screens | U (G7 pending) | Ability-based gating + tenant-scoped data once G4/G5 land |
| `src/components/NotificationDialog.vue`, `settings/Notifications.vue`, `TagsManager.vue`, `TagEditDialog.vue`, `ProxyDialog.vue`, `DockerHostDialog.vue`, `APIKeyDialog.vue` (+ settings variants) | Resource dialogs | U (G7 pending) | Follow resource tenancy from G1/G4 |
| `src/components/HeartbeatBar.vue`, `PingChart.vue`, `MonitorList*.vue`, `PublicGroupList.vue`, `Incident*.vue`, `StatusPage.vue` | Display components | U (G7 pending) | Data contracts unchanged; revisit during G7 sweep |

## Notification providers (`server/notification-providers/`, 107 files)

| Scope | Status | Reason |
| --- | --- | --- |
| Provider implementations | U | Dispatch envelope carries tenant context (G5), but provider internals receive the same JSON shape today; no ADR names any provider for modification. Revisit if G9 adds audit trails or G8 adds branded templates. |

## Tests (`test/backend-test/`)

| File(s) | Status | Phase |
| --- | --- | --- |
| `test-tenant-migration.js` *(new)* | T | G1 task-08 (up/down + backfill idempotency) |
| `test-tenant-auth.js` *(new)* | T | G2 task-12 (login/switch/logout/force-out matrix) |
| `test-rbac.js` *(new)* | T | G3 task-16 (role matrix acceptance) |
| `test-repo-tenant.js`, `test-tenant-idor.js` *(new)* | T | G4 tasks 17/20 (wrapper smoke + cross-tenant leak suite) |
| `test-tenant-engine.js` *(new)* | T | G5 task-23 (partitioned scheduler, quotas, metrics labels) |
| `test-tenant-status-page.js` *(new)* | T | G6 task-26 (routing scenarios × 12) |

---

### Traceability note

Every **T** entry cites the phase/task that authorizes it; the underlying decisions live in the four ADRs. If a later phase needs an entry currently marked **U**, that phase's planning must first confirm the change against these ADRs (new ADR if it contradicts one) and then flip the status here with a citation — silent promotion is not allowed. This mirrors the reviewer criterion "(e) the file-impact list does not invent changes the ADRs did not authorize".
