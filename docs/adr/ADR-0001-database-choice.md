# ADR-0001 — Database Choice for Multi-Tenant Uptime Kuma

- **ADR:** ADR-0001 — Database choice
Status: Proposed
Date: 2026-08-23
Deciders: CTO (architecture lead), Backend engineers (Dev1/Dev2), QA

## Context

Uptime Kuma v2.5.3 ships with **SQLite as the default database** and optional MariaDB/MySQL support. Persistence is split across two layers:

- **redbean-node** (`R.findOne / R.store / R.dispense`) for most runtime reads/writes,
- **Knex** for schema management (`db/knex_init_db.js` baseline plus 58 migrations, per `database-schema.md`).

Multi-tenancy changes the load profile fundamentally. Per `monitoring-engine.md`:

- Every started monitor writes one `heartbeat` row per interval via `Monitor.start()`'s beat loop (`server/model/monitor.js:1067`, `R.store(bean)`), and push-type monitors write through `/api/push/:pushToken` (`server/routers/api-router.js:125`). These are the only two heartbeat writers today, but with N tenants each running dozens of monitors at 20–60 s intervals, heartbeat insert volume scales linearly with tenant count.
- On top of each beat, `UptimeCalculator` performs **upserts into three aggregate tables** — `stat_minutely`, `stat_hourly`, `stat_daily` (`server/uptime-calculator.js:315–354`). Per `database-schema.md`, these tables carry per-monitor rows with multiple indexes; they are write-hot alongside `heartbeat`.
- A nightly retention job (`clear-old-data`, `server/jobs/clear-old-data.js:13`) bulk-deletes expired `heartbeat` and `stat_daily` rows; on SQLite this is a classic WAL-bloat and lock-contention trigger.

SQLite's writer model (a single database-level write lock) means concurrent tenants' beats serialize behind one writer. The upstream project itself acknowledges this: the `2025-12-22-0121-optimize-important-indexes` migration replaces two `heartbeat` indexes with **partial indexes on SQLite only** (`WHERE important = 1`), a workaround shape that MariaDB/MySQL do not support and that signals how close to the concurrency ceiling single-file storage already runs.

The plan mandates **backward compatibility**: existing single-user SQLite installations must continue to work unchanged. Any chosen target database therefore supplements SQLite for multi-tenant deployments; it does not remove it.

## Decision

Adopt **MariaDB (MySQL-compatible) as the target database engine for multi-tenant deployments**, accessed through the existing Knex + redbean-node stack with the already-bundled `mysql2` driver. Keep **SQLite** as the default engine for single-tenant/personal installations, preserving the upstream out-of-box experience.

Deciding factors for MariaDB over PostgreSQL:

1. **redbean-node does not support PostgreSQL — this is dispositive.** The ORM behind every model (`server/model/*.js`, `uptime-calculator.js`, `notification.js`) is `redbean-node ~0.3.3`, whose supported engines are exactly MySQL/MariaDB and SQLite (its README lists only those; its dist contains zero Postgres/`pg` dialect code). Choosing PostgreSQL would mean rewriting the entire data-access layer — work no G-phase task scopes — to reach the same isolation guarantees we already plan at the application layer (ADR-0002).
2. **MariaDB is the only exercised non-SQLite path.** All 58 Knex migrations already carry SQLite-vs-MariaDB dialect branches where outcomes differ (e.g., migration `2025-12-22-0121` gives SQLite partial indexes, MariaDB regular composites), and CI harnesses MariaDB via `@testcontainers/mariadb`. Adopting MariaDB extends a proven path instead of validating a third dialect.
3. **Driver cost is zero.** `mysql2 ~3.11.5` is already a dependency; both Knex (`~3.1.0`) and redbean-node speak it natively.
4. What we forgo versus PostgreSQL is acceptable here: partial indexes (MariaDB uses full composite indexes on `heartbeat` — the pre-existing upstream behavior on that engine) and native RLS (isolation is instead enforced by the G4 tenant-safe repository wrapper plus composite FKs per ADR-0002, with IDOR tests from G4 onward).

Backward compatibility: existing single-user SQLite installations keep working unchanged in single-tenant mode (default tenant, see ADR-0002); multi-tenant mode requires a MariaDB connection, enforced at setup.

## Consequences

- **Driver choice:** no change — `mysql2` via the existing stack; connection pooling sized against concurrent beat-loop counts becomes an operational parameter we own.
- **Migration tooling:** unchanged mechanics; new migrations must keep satisfying the dual-dialect rule (SQLite + MariaDB) per `db/knex_migrations/README.md`, reusing the established dialect-branch pattern.
- **Operational burden:** multi-tenant operators run a MariaDB service (`mariadb-dump`/`mysqldump` backups); single-tenant SQLite users are unaffected — this preserves the backward-compatibility mandate.
- **Index parity gap:** the SQLite-only partial indexes on `heartbeat` have no MariaDB equivalent; multi-tenant hot-path tuning relies on composite `(monitor_id, …)` / `(tenant-leading)` indexes (G1), not partial predicates.
- **Performance:** heartbeat/stat write paths gain row-level MVCC concurrency over SQLite's single-writer lock; the nightly retention `DELETE` runs without WAL-bloat side effects.

## Alternatives

- **PostgreSQL (rejected):** strongest paper feature set for tenancy — partial indexes port 1:1, native Row-Level Security as defense-in-depth beneath the app filter, mature MVCC. Rejected because redbean-node has **no PostgreSQL support at all** (README + dist evidence above), so it forces an unscoped ORM/data-layer rewrite across every model, calculator, and notification path. RLS through RedBean would additionally require setting session variables on every pooled connection from inside its pool management — high-risk plumbing with an app-layer substitute already planned (G4 wrapper).
- **SQLite everywhere (rejected):** a single database-level write lock serializes heartbeat/stat upserts across all tenants; bulk retention deletes stall writers; WAL grows unbounded under sustained multi-tenant write pressure. Per `database-schema.md`, the codebase already needed partial-index surgery on SQLite just to keep `heartbeat` queries efficient for *one* tenant — N tenants compounds this.
- **Database-per-tenant (rejected):** strongest isolation, but N databases means N backup/restore cycles, N migration executions per release (58 migrations × N), unbounded connection-pool growth, and painful fleet-wide queries for platform administration. Operationally incompatible with the project's zero-cost, single-appliance deployment model.
- **Schema-per-tenant (rejected):** avoids some DB-per-tenant costs but breaks the Knex migration contract: the migration runner operates on a single schema namespace, so every deploy must replay migrations per tenant schema inside one transaction budget. Catalog churn and connection `search_path` management add failure modes with no benefit over a well-indexed `tenant_id` column.
