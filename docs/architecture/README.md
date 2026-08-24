# Target Architecture — Multi-Tenant Uptime Kuma (Phase G0 Package)

> This directory is the **target architecture package** produced by Phase G0 and is the entry point for team signoff. It synthesizes the [codebase survey](./survey/README.md) (G0.01) and the four [ADRs](../adr/README.md) (G0.02) into the deliverables the plan's G0 Definition of Done requires.
>
> **Status: Phase G0 complete — this package is ready for team signoff** (reviewer: tech lead / maintainer, per kanban task G0.03). Downstream phases must treat these documents as authoritative inputs.

## Document map

| Artifact | File | What it answers |
| --- | --- | --- |
| Codebase & schema survey (input, G0.01) | [`survey/`](./survey/README.md) | What exists today — schema, API/socket surface, monitoring engine touchpoints, candidate impact map |
| Database choice ADR (G0.02) | [`../adr/ADR-0001-database-choice.md`](../adr/ADR-0001-database-choice.md) | MariaDB as multi-tenant engine via existing `mysql2`/Knex/redbean stack; SQLite retained for single-user installs |
| Isolation model ADR (G0.02) | [`../adr/ADR-0002-isolation-model.md`](../adr/ADR-0002-isolation-model.md) | Shared DB/schema + `tenant_id` column; anchor-subquery pattern for child tables |
| Routing & tenant resolution ADR (G0.02) | [`../adr/ADR-0003-routing-and-tenant-resolution.md`](../adr/ADR-0003-routing-and-tenant-resolution.md) | Caddy edge + `resolveTenant()` priority: subdomain → custom domain → guarded `X-Tenant-ID` → JWT claim |
| Auth strategy ADR (G0.02) | [`../adr/ADR-0004-authentication-strategy.md`](../adr/ADR-0004-authentication-strategy.md) | JWT access + rotating refresh; CASL RBAC with 4 frozen roles; per-tenant membership |
| ERD — AS-IS | [`erd-as-is.md`](./erd-as-is.md) | Current 27-table schema with real FK/cascade facts and isolation seams |
| ERD — TO-BE | [`erd-to-be.md`](./erd-to-be.md) | Post-G1 schema: tenant root tables, `tenant_id` on ten business tables, unchanged child family |
| End-to-end architecture | [`architecture-diagram.md`](./architecture-diagram.md) | Client → Caddy → resolveTenant chain → guards → repository → DB/engine flows; socket rooms `(tenant_id, user_id)` |
| Risk register | [`risk-mitigation.md`](./risk-mitigation.md) | R1–R14 risks with severity, mitigation, owning phase |
| File impact list | [`file-impact-list.md`](./file-impact-list.md) | Targeted vs unconfirmed file modifications grouped by phase G1→G12 |
| Migration contract | [`migration-contract.md`](./migration-contract.md) | Six frozen clauses binding Phase G1's data-model work |

## How to consume this package

- **Phase G1** implements [migration-contract.md](./migration-contract.md) exactly; it may not deviate without a new ADR. Note the contract's *Supersession record* — ADR-0002's no-redundant-column rule overrides older illustrative table lists.
- **Phase G2** consumes `resolveTenant()` in [architecture-diagram.md](./architecture-diagram.md) plus ADR-0003/0004.
- **Phase G4** consumes [file-impact-list.md](./file-impact-list.md) to scope repository refactors.
- **Phase G5** consumes the engine portion of [architecture-diagram.md](./architecture-diagram.md).
- **Phase G6** consumes routing/CNAME/branding decisions from ADR-0003 and the diagram.
- **Phase G9** owns the live version of [risk-mitigation.md](./risk-mitigation.md).

## G0 Definition of Done checklist

- [x] Team signs off on target architecture → **this package is the signoff artifact**
- [x] ADRs committed under `docs/adr/`
- [x] ERD AS-IS and TO-BE exist
- [x] Risk & mitigation plan exists
- [x] File/module modification list exists

Once the reviewer signs off on task G0.03, Phase G0 closes and Phase G1 (kanban tasks 04–08) begins against the migration contract.
