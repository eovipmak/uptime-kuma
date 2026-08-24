# Architecture Decision Records

Foundational ADRs for the multi-tenant Uptime Kuma fork (plan phase G0.02). Each ADR follows the Context → Decision → Consequences → Alternatives format. Status `Proposed` until team signoff; do not reopen after signoff within this task.

| ADR | Title | Status | Feeds phases |
| --- | --- | --- | --- |
| [ADR-0001](ADR-0001-database-choice.md) | Database choice (MariaDB target, SQLite retained) | Proposed | G1 |
| [ADR-0002](ADR-0002-isolation-model.md) | Isolation model: shared DB + shared schema + `tenant_id` | Proposed | G1, G4 |
| [ADR-0003](ADR-0003-routing-and-tenant-resolution.md) | Routing (Caddy) and `resolveTenant()` priority order | Proposed | G2, G6 |
| [ADR-0004](ADR-0004-authentication-strategy.md) | Auth strategy (JWT access + rotating refresh) and RBAC model | Proposed | G2, G3 |

Evidence base: the G0.01 AS-IS survey under [`docs/architecture/survey/`](../architecture/survey/) — `database-schema.md`, `api-and-socket-events.md`, `monitoring-engine.md`, `file-impact-map.md`.

Consumers: task G0.03 merges these decisions into the TO-BE ERD and architecture diagram. The "Decision" section of each ADR is the contract later phases must respect.
