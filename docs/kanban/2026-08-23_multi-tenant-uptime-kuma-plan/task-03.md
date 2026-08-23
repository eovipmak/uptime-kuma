# Task G0.03 — Target Architecture Synthesis & Risk Plan

**Phase:** G0 — Foundation (Survey & Design)
**Status:** todo
**Reviewer:** Tech lead / Uptime Kuma maintainer (final G0 signoff)

## Objective

Synthesize the G0.01 survey and the G0.02 ADRs into the final target-architecture package required to close Phase G0: the TO-BE ERD, an end-to-end architecture diagram, a risk & mitigation plan, and the consolidated file/module modification list that downstream phases (G1+) will consume. This is the "team signs off on target architecture" Definition of Done for the plan's G0 phase.

## Prerequisites/dependencies

- **Task G0.01** (codebase survey) reviewed and approved.
- **Task G0.02** (four ADRs) reviewed and approved.
- **If either prerequisite is incomplete or its ADRs are still `Status: Proposed` without reviewer signoff:** stop, report the blocker, and do not synthesize — an unapproved ADR cannot drive the TO-BE architecture.
- This task depends on **both** 01 and 02; it is not a parallelizable wave.

## Owner / recommended agent profile

**System designer / tech lead** — able to translate ADRs into an end-to-end design and reason about cross-cutting risks (security, performance, migration, ops). Read-only with respect to production source. Owns the final G0 deliverable for signoff.

## Exact files and artifacts to create

All outputs go under `docs/architecture/` (not `docs/architecture/survey/`, which is G0.01's area):

1. `docs/architecture/README.md` — top-level architecture overview, links the survey, ADRs, ERD, risks, and modification list.
2. `docs/architecture/erd-as-is.md` — ERD of the current schema (mermaid `erDiagram`), sourced from G0.01's `database-schema.md`.
3. `docs/architecture/erd-to-be.md` — ERD of the target multi-tenant schema (mermaid `erDiagram`), incorporating the `tenant`, `tenant_user`, `tenant_invitation` tables from the plan's G1, the `tenant_id` column on existing tables per ADR-0002, composite indexes per ADR-0002, and FK cascade per ADR-0002.
4. `docs/architecture/architecture-diagram.md` — end-to-end TO-BE architecture diagram (mermaid `flowchart` or C4 context) covering: client → reverse proxy (ADR-0003) → Express + Socket.IO (with `resolveTenant` middleware) → DB (ADR-0001) → optional Redis cache → notification dispatcher → heartbeat writer/scheduler → Prometheus labels.
5. `docs/architecture/risk-mitigation.md` — risk register table for the entire multi-tenant initiative with at least the risks the plan flags (cross-tenant leak, noisy neighbor, migration data loss, SSRF in monitor URLs, JWT tampering, custom-domain SSL) plus any new ones found during synthesis.
6. `docs/architecture/file-impact-list.md` — the consolidated, authoritative list of files/modules that downstream phases will need to modify, grouped by phase (G1..G12) where already inferable; entries taken from G0.01's `file-impact-map.md` but promoted from "candidate" to "targeted" where the ADRs confirm the decision.
7. `docs/architecture/migration-contract.md` — a short contract describing what G1 (Data Model & Migration) must deliver: list of new tables, list of tables gaining `tenant_id`, default-tenant seeding requirement, idempotency requirement, rollback-without-data-loss requirement. This is a contract, not the migration scripts themselves.

No source code is to be created or modified.

## Concrete implementation steps

1. **Open and read every G0.01 survey file and every G0.02 ADR before writing.** If any is missing or still `Proposed` without signoff, stop and report.
2. **`erd-as-is.md`:** render the current schema as a mermaid `erDiagram`, one entity per major table from `database-schema.md`, with relationships reflecting FKs (e.g., `heartbeat.monitor_id` → `monitor.id`, `monitor_tag` as join table).
3. **`erd-to-be.md`:** render the post-G1 schema. Add `tenant` entity with attributes from the plan's G1 section. Add `tenant_user` and `tenant_invitation`. For each existing table listed in ADR-0002's decision, add a `tenant_id` attribute and an index notation. Show the `tenant` → `monitor`, `tenant` → `notification`, etc., FKs with `ON DELETE CASCADE` as required by the plan's G1.
4. **`architecture-diagram.md`:** draw the end-to-end flow per ADR-0003's routing strategy and ADR-0004's auth strategy. Show the `resolveTenant()` middleware as a labeled box on the request path. Show Socket.IO rooms partitioned by `tenant_id`. Show scheduler loading monitors partitioned by `tenant_id`. Show Prometheus metrics with `tenant_id` label (referenced from plan G5 but only as boxes, no implementation detail).
5. **`risk-mitigation.md`:** produce a table with columns: `ID`, `Risk`, `Source (plan section or ADR)`, `Severity (H/M/L)`, `Mitigation`, `Owning Phase (G1..G12)`. Include at minimum:
   - R1 Cross-tenant data leak via missed `tenant_id` filter (G1, G4).
   - R2 Noisy neighbor: one tenant's 10k monitors delaying others (G5).
   - R3 Migration data loss on rollback (G1).
   - R4 SSRF via monitor URLs (G9).
   - R5 JWT tampering / tenant claim forgery (G2, G9).
   - R6 Custom-domain SSL automation failure (G6, G10).
   - R7 Backward compatibility break for existing single-tenant deployments (G1, all of P0).
   - Add any additionally identified risks discovered during ADR review.
6. **`file-impact-list.md`:** take G0.01's `file-impact-map.md` (candidate entries) and, for each entry, look up the corresponding ADR — if ADR-0001/0002/0003/0004 confirms the change is needed, mark the entry `targeted` and note the phase it belongs to (e.g., `server/model/monitor.js` → G1 + G4 + G5). Leave any entry that no ADR addresses as `unconfirmed` for a later phase to decide; do not fabricate.
7. **`migration-contract.md`:** write a precise contract for the next phase:
   - New tables: `tenant`, `tenant_user`, `tenant_invitation` (attributes per plan G1).
   - Tables gaining `tenant_id` column: enumerate from ADR-0002 and G0.01's schema survey.
   - Required composite indexes: list the `(tenant_id, ...)` patterns.
   - Default tenant seeding: all existing data must be assigned to a single default tenant.
   - Idempotency: migration must run cleanly on an empty DB and on a populated DB.
   - Rollback: must not lose existing data.
   - **This is a contract document, not SQL.** G1 will implement against it.
8. **`README.md`:** index everything — link the G0.01 survey, the four ADRs, the two ERDs, the architecture diagram, the risk register, the file-impact list, and the migration contract. State explicitly that this completes the G0 Definition of Done and the package is ready for team signoff.
9. Do not modify any production source.

## Interfaces/contracts and integration points

- **Upstream consumer of this task:** team signoff on G0 (the plan's Definition of Done for Phase 0).
- **Downstream consumers:**
  - Phase G1 consumes `migration-contract.md` as the authoritative input; G1 must not deviate without a new ADR.
  - Phase G2 consumes the `resolveTenant` portion of `architecture-diagram.md` and ADR-0003/0004.
  - Phase G4 consumes `file-impact-list.md` to know which repositories to refactor.
  - Phase G5 consumes the scheduler portion of `architecture-diagram.md`.
  - Phase G9 consumes `risk-mitigation.md`.
- **Format contract:** ERDs must be mermaid `erDiagram`, architecture diagram must be mermaid `flowchart` (or C4). Risk register must be a Markdown table. All cross-references must use relative paths so links work in the repo.

## Acceptance criteria

- [ ] All seven output files exist under `docs/architecture/` (excluding the `survey/` subdirectory which belongs to G0.01).
- [ ] `erd-as-is.md` contains a valid mermaid `erDiagram` block covering every table documented in G0.01's `database-schema.md`.
- [ ] `erd-to-be.md` contains a valid mermaid `erDiagram` with `tenant`, `tenant_user`, `tenant_invitation` entities and `tenant_id` attributes on existing tables per ADR-0002.
- [ ] `architecture-diagram.md` contains a valid mermaid `flowchart` showing the path: client → reverse proxy → tenant resolver → app → DB, and shows Socket.IO rooms partitioned by `tenant_id`.
- [ ] `risk-mitigation.md` lists at minimum R1–R7 above with `Severity`, `Mitigation`, and `Owning Phase` columns.
- [ ] `file-impact-list.md` marks each entry as `targeted` or `unconfirmed` (no bare "candidate" leftovers from G0.01 without a status).
- [ ] `migration-contract.md` enumerates (a) new tables, (b) tables gaining `tenant_id`, (c) required indexes, (d) default-tenant seeding, (e) idempotency, (f) rollback-without-data-loss — six explicit clauses.
- [ ] No source file under `server/`, `src/`, `db/`, or `config/` is modified.
- [ ] README.md cross-links every G0 output and explicitly says "Phase G0 ready for signoff".

## Verification commands/checks

Run from repository root:

```bash
# 1. All seven output files exist
for f in README erd-as-is erd-to-be architecture-diagram risk-mitigation file-impact-list migration-contract; do
  test -f "docs/architecture/$f.md" && echo "OK: $f.md" || echo "MISSING: $f.md"
done

# 2. Mermaid ERD blocks present
grep -qE '```mermaid' docs/architecture/erd-as-is.md && echo "OK as-is mermaid" || echo "MISSING as-is mermaid"
grep -qE '```mermaid' docs/architecture/erd-to-be.md && echo "OK to-be mermaid" || echo "MISSING to-be mermaid"

# 3. To-BE ERD references tenant tables
for t in tenant tenant_user tenant_invitation; do
  grep -q "\b$t\b" docs/architecture/erd-to-be.md && echo "OK entity: $t" || echo "MISSING entity: $t"
done

# 4. Architecture diagram has flowchart and tenant room
grep -qE 'flowchart' docs/architecture/architecture-diagram.md && echo "OK flowchart" || echo "MISSING flowchart"
grep -iq 'tenant_id' docs/architecture/architecture-diagram.md && echo "OK tenant_id labeled" || echo "MISSING tenant_id label"

# 5. Risk register covers R1-R7
for r in "Cross-tenant" "Noisy neighbor" "Migration" "SSRF" "JWT" "SSL" "Backward"; do
  grep -iq "$r" docs/architecture/risk-mitigation.md && echo "OK risk: $r" || echo "MISSING risk: $r"
done

# 6. Migration contract has the six required clauses
for c in "New tables" "tenant_id" "index" "default tenant" "[Ii]dempoten" "[Rr]ollback"; do
  grep -iq "$c" docs/architecture/migration-contract.md && echo "OK clause: $c" || echo "MISSING clause: $c"
done

# 7. No production code changed
git status --short | grep -vE '^\?\? docs/' && echo "VIOLATION: non-docs changes" || echo "OK: only docs changed"

# 8. Mermaid syntax sanity (best-effort, optional; only if mmdc is available)
command -v mmdc >/dev/null 2>&1 && mmdc -i docs/architecture/erd-to-be.md -o /tmp/erd-tobe.svg && echo "OK ERD renders" || echo "WARN: mmdc not available, manual review required"
```

## Reviewer

Uptime Kuma tech lead / maintainer — this is the final Phase G0 signoff. Reviewer should confirm:
- (a) the TO-BE ERD is consistent with the four ADRs,
- (b) the architecture diagram's `resolveTenant` flow matches ADR-0003's priority order,
- (c) the risk register is actionable and each risk has an owning phase,
- (d) the migration contract is precise enough that Phase G1 can begin immediately,
- (e) the file-impact list does not invent changes the ADRs did not authorize.

Only after reviewer signoff, append the coordinator-status block and close Phase G0.

## Explicit out-of-scope

- **Do not** begin Phase G1 work (no migration files, no seed scripts, no model changes).
- **Do not** write any production code under `server/`, `src/`, or `db/`.
- **Do not** reopen or rewrite the G0.02 ADRs — they are prerequisite inputs; if an ADR is wrong, raise a blocker and stop.
- **Do not** produce runbooks, deployment configs, or CI changes — those belong to G9..G12.
- **Do not** make billing/pricing decisions — G8 territory.
- **Do not** promise tooling (Redis, Caddy, Prometheus) as installed artifacts — the architecture diagram describes intent; procurement/installation happens in later phases.
