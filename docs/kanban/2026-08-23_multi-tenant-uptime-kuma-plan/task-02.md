# Task G0.02 — Architecture Decision Records (ADRs) for Multi-Tenancy

**Phase:** G0 — Foundation (Survey & Design)
**Status:** todo
**Reviewer:** Tech lead / Uptime Kuma maintainer

## Objective

Author the four foundational Architecture Decision Records (ADRs) required by the plan's G0 deliverables, capturing the critical technical decisions for multi-tenancy: database choice, isolation model, routing strategy, and authentication strategy. Each ADR must follow the Context → Decision → Consequences → Alternatives format specified in the plan's "Hướng dẫn cho AI Agent" section.

## Prerequisites/dependencies

- **Task G0.01** must be reviewed and approved. The four ADRs depend on the concrete table inventory, endpoint inventory, and impact map produced there. Without Task G0.01's `database-schema.md` and `file-impact-map.md`, this task has no evidentiary basis.
- **If Task G0.01 is not complete:** stop, report the blocker ("Waiting on G0.01 survey artifacts"), and do not invent findings.

## Owner / recommended agent profile

**Backend architect** — strong background in multi-tenant SaaS architectures on Node.js, database design (SQLite/PostgreSQL/MySQL), reverse proxy routing (Caddy/Traefik/Nginx), and JWT/Session auth. Must not modify any production source.

## Exact files and artifacts to create

Create the `docs/adr/` directory (does not yet exist). Produce exactly four ADR files, numbered for referenceability:

1. `docs/adr/ADR-0001-database-choice.md`
2. `docs/adr/ADR-0002-isolation-model.md`
3. `docs/adr/ADR-0003-routing-and-tenant-resolution.md`
4. `docs/adr/ADR-0004-authentication-strategy.md`

Optionally, add `docs/adr/README.md` as a lightweight index linking the four ADRs.

No source code is to be created or modified.

## Concrete implementation steps

1. **Read inputs first.** Open the four survey documents from Task G0.01 (`docs/architecture/survey/*.md`) before writing anything. If any of the four survey files is missing, stop and report the blocker.
2. **ADR-0001 — Database choice:**
   - Context: Uptime Kuma today ships SQLite with optional MariaDB/MySQL. Multi-tenant workloads add per-tenant concurrency, heartbeat write volume, and potential replication needs. Cite the schema survey's heartbeat/stat tables as concurrency hotspots.
   - Decision: recommend a target database. The plan suggests PostgreSQL/MySQL; pick one and justify against Uptime Kuma's existing RedBean + Knex stack.
   - Consequences: driver choice, migration tooling changes, operational burden, backward compatibility with existing SQLite deployments (the plan mandates backward compatibility — call this out).
   - Alternatives: SQLite (rejected for concurrency reasons — explain why), MySQL vs PostgreSQL (give the deciding factor), DB-per-tenant (rejected, explain cost), schema-per-tenant (rejected, explain migration complexity).
3. **ADR-0002 — Isolation model:**
   - Context: three options listed in the plan (Shared DB + Shared Schema + `tenant_id`; Shared DB + Schema-per-tenant; DB-per-tenant).
   - Decision: recommend **Shared DB + Shared Schema + `tenant_id`** column (the plan's stated recommendation). Justify by simplicity and fit with Uptime Kuma's single-instance deployment model.
   - Consequences: every query must filter by `tenant_id`; need composite indexes `(tenant_id, ...)`, FK cascade on `tenant_id`, no cross-tenant joins, lint rule effort (deferred to G4).
   - Alternatives: schema-per-tenant (complex Knex migration story), DB-per-tenant (operational cost, backup complexity).
4. **ADR-0003 — Routing and tenant resolution:**
   - Context: status page must be reachable via subdomain, path, and custom domain with auto SSL. Reference G0.01's status-page-router survey.
   - Decision: recommend a reverse proxy (Caddy with auto-HTTPS, Traefik with dynamic config, or Nginx + certbot — pick one with justification). Define `resolveTenant()` middleware priority order exactly as in the plan (subdomain → custom domain → `X-Tenant-ID` header → session/JWT claim).
   - Consequences: TLS automation, DNS/CNAME verification flow, caching implications for public status pages.
   - Alternatives: list the two reverse proxies not chosen and explain why.
5. **ADR-0004 — Authentication strategy:**
   - Context: a user can belong to multiple tenants with different roles (per plan G3). Session/JWT payload must carry `user_id`, `tenant_id`, `role`, `permissions`.
   - Decision: recommend JWT access token + refresh token vs session-based. Recommend whether `tenant_id` lives in the token claim or is resolved per-request via the middleware from ADR-0003 (the plan implies both — be explicit about which is authoritative).
   - Consequences: token rotation on tenant switch, edge case "user removed from tenant while online → force logout", token storage.
   - Alternatives: stateless JWT vs server-side sessions — decide and justify.
6. **Format compliance:** every ADR must include the four required sections — **Context**, **Decision**, **Consequences**, **Alternatives** — and a header with `ADR-XXXX`, `Status: Proposed`, `Date: 2026-08-23`, `Deciders: <role>`.
7. Do **not** start implementation work or modify any production file. These are proposals for team signoff.

## Interfaces/contracts and integration points

- **Upstream consumer:** Task G0.03 (target architecture synthesis) will merge the four ADRs into the TO-BE ERD and architecture diagram. The "Decision" section of each ADR is the contract G0.03 must respect.
- **Downstream consumers:** later phases:
  - ADR-0001 → G1 (Data Model & Migration) drives DB driver/migration choices.
  - ADR-0002 → G1, G4 (Repository/Query Layer) drives `tenant_id` enforcement.
  - ADR-0003 → G2, G6 (Tenant Context, Status Page).
  - ADR-0004 → G2 (Authentication & Tenant Context).
- **Format contract:** the four required section headers must be present verbatim. Reviewers will grep for them.

## Acceptance criteria

- [ ] `docs/adr/` contains exactly `ADR-0001-database-choice.md`, `ADR-0002-isolation-model.md`, `ADR-0003-routing-and-tenant-resolution.md`, `ADR-0004-authentication-strategy.md` (and optionally `README.md`).
- [ ] Each ADR has `Status: Proposed`, `Date: 2026-08-23`, and a `Deciders:` line.
- [ ] Each ADR has all four required sections verbatim: `## Context`, `## Decision`, `## Consequences`, `## Alternatives`.
- [ ] Each ADR cites at least one finding from the G0.01 survey (e.g., "per `database-schema.md`, the `heartbeat` and `stat_minutely` tables are write-hot").
- [ ] ADR-0002 explicitly recommends the plan's stated `tenant_id` model (or documents a justified deviation — but the plan's framing must be addressed).
- [ ] ADR-0003 lists the `resolveTenant()` priority order.
- [ ] No source file under `server/`, `src/`, `db/`, or `config/` is modified.

## Verification commands/checks

Run from repository root:

```bash
# 1. All four ADR files exist
for id in 0001-database-choice 0002-isolation-model 0003-routing-and-tenant-resolution 0004-authentication-strategy; do
  test -f "docs/adr/ADR-$id.md" && echo "OK ADR-$id" || echo "MISSING ADR-$id"
done

# 2. Required sections present in each ADR
for f in docs/adr/ADR-000*.md; do
  for section in "Context" "Decision" "Consequences" "Alternatives"; do
    grep -qE "^## $section\b" "$f" && echo "OK $f :: $section" || echo "MISSING $f :: $section"
  done
done

# 3. Status header present
for f in docs/adr/ADR-000*.md; do
  grep -q "^Status: Proposed" "$f" && echo "OK status in $f" || echo "MISSING status in $f"
done

# 4. Cites G0.01 survey
grep -rlE "database-schema\.md|api-and-socket-events\.md|monitoring-engine\.md|file-impact-map\.md" docs/adr/ >/dev/null && echo "OK cites survey" || echo "WARNING: no survey citation found"

# 5. No source code modified
git status --short | grep -vE '^\?\? docs/' && echo "VIOLATION: non-docs changes" || echo "OK: only docs changed"
```

## Reviewer

Uptime Kuma tech lead / maintainer. Reviewer should specifically challenge: (a) is the DB choice justified against the concurrency evidence, (b) does the isolation model preserve the plan's backward-compatibility mandate, (c) is the `resolveTenant()` priority practical, (d) does the auth strategy have a clear tenant-switch flow.

## Explicit out-of-scope

- **Do not** produce the full TO-BE architecture diagram — that is Task G0.03.
- **Do not** implement migration scripts, middleware, or RBAC code.
- **Do not** pick a billing provider or SaaS pricing — G8 territory.
- **Do not** choose observability stack (OpenTelemetry, Grafana) — G9 territory.
- **Do not** modify production source or run migrations.
- **Do not** reopen ADRs after team signoff in this task; that is a separate process.
