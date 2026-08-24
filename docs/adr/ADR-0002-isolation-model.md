# ADR-0002 — Tenant Isolation Model

- **ADR:** ADR-0002 — Isolation model: shared DB, shared schema, `tenant_id` column
Status: Accepted
Date: 2026-08-23
Deciders: CTO (architecture lead), Backend engineers (Dev1/Dev2), QA

## Context

Per `database-schema.md`, the AS-IS schema has 27 tables. The `user_id` scoping summary shows the isolation seams today:

- Some business tables are owner-scoped by a (usually nullable) `user_id` column — `monitor`, `api_key`, `docker_host`, `proxy`, `notification`, `maintenance`, `remote_browser` — but several of those declare no FK at all, and `status_page`, `group`, `tag`, `incident`, and `status_page_cname` carry **no owner column whatsoever** (`database-schema.md` §user_id scoping summary).
- High-volume child tables — `heartbeat`, `stat_minutely`, `stat_hourly`, `stat_daily` — have **no `user_id`**; they are anchored indirectly through `monitor_id` (`monitoring-engine.md`: both heartbeat writers set only `bean.monitor_id`).
- Global/config tables (`setting`, `user`) are instance-wide.

Three candidate isolation models were considered (per the plan):

1. Shared DB + shared schema + `tenant_id` column,
2. Shared DB + schema-per-tenant,
3. Database-per-tenant.

The plan states its recommendation for option 1 and mandates backward compatibility: an existing single-user install must keep working after upgrade.

## Decision

Adopt **shared database + shared schema + a `tenant_id` column** as the isolation model:

- A new `tenant` root table is introduced (plan G1 task-04); every business table gains a non-null `tenant_id` FK → `tenant.id` with cascade semantics on tenant deletion.
- **Every tenant-scoped query filters by `tenant_id`** — no exceptions ("Mọi query DB đều bắt buộc filter theo `tenant_id`. Không có ngoại lệ."). Enforcement is layered:
  - G4 wraps redbean/Knex access with a tenant-safe repository that injects `tenant_id` automatically;
  - documented exemptions only for genuinely global tables (`setting`, `user`) carry an inline rationale + eslint directive;
  - HTTP/socket guards (G2) resolve tenant context before any handler runs.
- **Composite indexes** `(tenant_id, …)` replace or augment existing `user_id`-leading indexes so per-tenant queries stay index-covered.
- **Child tables keep FK anchoring to `monitor`; no redundant `tenant_id` column.** Isolation for `heartbeat`, `stat_*`, `monitor_tag`, `monitor_notification`, `monitor_tls_info`, `incident` uses the pattern `monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)` (plan G1/G5 convention). This avoids doubling index maintenance on the write-hot tables identified in ADR-0001.
- **No cross-tenant joins.** Any future cross-tenant feature requires an explicit ADR revision.
- **Backward compatibility:** a migration backfills every legacy row into a single **default tenant** (plan G1 task-06). An upgraded single-user install behaves identically: its data all belongs to the default tenant, and queries match `(user_id, tenant_id = default)` returning the same result sets.
- A static-analysis ESLint rule (`require-tenant-scope`) catches unscoped queries — deferred to phase G4 per plan.

This matches the plan's stated recommendation; we adopt it rather than deviate because it fits Uptime Kuma's single-instance appliance deployment model and the zero-cost constraint.

## Consequences

- **Discipline burden:** every query path — REST router, Socket.IO handler, monitor beat loop, uptime calculator, retention jobs — must flow through the tenant-scoped wrapper. Bypassing it risks cross-tenant leakage (IDOR class bugs); this is why enforcement is triple-layered (HTTP middleware, repository wrapper, socket guards) rather than trust-based.
- **Index/migration cost:** every business table needs a composite-index migration; the write-hot `heartbeat`/`stat_*` family deliberately does *not* get extra columns/indexes, keeping their write amplification unchanged.
- **FK cascades:** deleting a tenant cascades across ~20 tables; deletion runs in a transaction with progress logging to avoid long lock windows.
- **Backup/restore granularity is whole-instance.** Per-tenant restore is not possible without tooling built later; acceptable for a self-hosted appliance model.
- **Shared-schema noise:** one noisy tenant's row volume sits next to others'; mitigations (quota gates in G5, per-tenant retention) are scheduled in later phases, not here.
- **Testing:** every backend test suite gains a cross-tenant assertion dimension from G4 onward (IDOR tests).

## Alternatives

- **Schema-per-tenant (rejected):** Knex migrations assume one schema namespace; 58 migrations × N tenants per deploy makes DDL time and failure recovery unmanageable, and connection strings need `search_path` juggling. Migration complexity is disproportionate to the isolation benefit at this product scale.
- **Database-per-tenant (rejected):** best blast-radius isolation but N× backup jobs, N× connection pools, no fleet-wide admin queries, and materially higher operational cost — incompatible with the zero-cost constraint and the single-binary heritage of Uptime Kuma.
- **Do nothing / user_id-only scoping (rejected):** the survey shows child tables (`heartbeat`, `stat_*`) have no `user_id` at all, so user-scoping alone cannot express tenancy; sharing monitors between multiple users of one tenant would be impossible.
