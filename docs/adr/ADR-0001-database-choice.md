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

Adopt **PostgreSQL (v16+)** as the target database engine for multi-tenant deployments, accessed through the existing Knex stack (`pg` dialect). Keep **SQLite** as the default engine for single-tenant/personal installations, preserving the upstream out-of-box experience. MariaDB/MySQL retains legacy read support but is not the recommended multi-tenant engine.

Deciding factors for PostgreSQL over MySQL/MariaDB:

1. **Partial indexes** — PostgreSQL natively supports the `WHERE important = 1` partial-index shape that migration `2025-12-22-0121` introduced on SQLite for `heartbeat`. The optimized index design ports 1:1 instead of degrading to full composite indexes.
2. **Row-Level Security (RLS)** — PostgreSQL offers policy-based row filtering, usable as defense-in-depth *beneath* the application-level `tenant_id` filter (ADR-0002). MySQL has no equivalent.
3. **MVCC concurrency** — readers never block writers; heartbeat inserts from many tenants proceed without the table-level lock contention that InnoDB can exhibit on high-churn secondary indexes.
4. **Stack fit** — Knex first-class `pg` dialect; JSONB for the brotli/structured response payloads currently stuffed into `text` columns; mature zero-cost hosting (any VPS, Docker).

Risk flagged for G1: **redbean-node driver coverage for PostgreSQL must be verified in a G1 spike.** If any redbean code path lacks a working `pg` driver, the G1 tenant-safe repository wrapper (plan phase G4 predecessor work) routes those calls through Knex query-builder methods instead. This spike gates the final driver layout but does not change the engine choice.

## Consequences

- **Driver choice:** `pg` (node-postgres) via Knex; connection pooling configured per deployment (PgBouncer optional, still zero-cost). A redbean↔pg compatibility spike is required early in G1.
- **Migration tooling:** all 58 existing Knex migrations already run under Knex dialects; new migrations must avoid raw SQL that is dialect-specific (per `db/knex_migrations/README.md` rules). Fresh-install baseline (`knex_init_db.js`) gains a PostgreSQL variant path.
- **Operational burden:** multi-tenant operators now run a Postgres service (backup via `pg_dump`, point-in-time recovery available). Single-tenant SQLite users are unaffected — this preserves the backward-compatibility mandate.
- **Backward compatibility:** SQLite remains fully supported; the G1 migration framework must produce dialect-aware column definitions (e.g., `timestamptz` on PG, integer epoch on SQLite) exactly as the existing MariaDB-vs-SQLite branches already do.
- **Performance:** heartbeat/stat write paths gain headroom; the nightly retention `DELETE` benefits from PG autovacuum instead of SQLite incremental-vacuum jobs.

## Alternatives

- **SQLite everywhere (rejected):** a single database-level write lock serializes heartbeat/stat upserts across all tenants; bulk retention deletes stall writers; WAL grows unbounded under sustained multi-tenant write pressure. Per `database-schema.md`, the codebase already needed partial-index surgery on SQLite just to keep `heartbeat` queries efficient for *one* tenant — N tenants compounds this.
- **MariaDB/MySQL (rejected):** supported upstream today, but no partial indexes (loses the `heartbeat` optimization portability shown in migration `2025-12-22-0121`), no row-level security, and weaker JSON handling than PostgreSQL. Nothing in the multi-tenant requirements favors it over PostgreSQL.
- **Database-per-tenant (rejected):** strongest isolation, but N databases means N backup/restore cycles, N migration executions per release (58 migrations × N), unbounded connection-pool growth, and painful fleet-wide queries for platform administration. Operationally incompatible with the project's zero-cost, single-appliance deployment model.
- **Schema-per-tenant (rejected):** avoids some DB-per-tenant costs but breaks the Knex migration contract: the migration runner operates on a single schema namespace, so every deploy must replay migrations per tenant schema inside one transaction budget. Catalog churn (`pg_class` bloat / information_schema scans) and connection `search_path` management add failure modes with no benefit over a well-indexed `tenant_id` column.
