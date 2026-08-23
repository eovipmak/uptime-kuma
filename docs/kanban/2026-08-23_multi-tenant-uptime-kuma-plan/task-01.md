# Task G0.01 — Codebase & Database Schema Survey

**Phase:** G0 — Foundation (Survey & Design)
**Status:** todo
**Reviewer:** Tech lead / Uptime Kuma maintainer

## Objective

Produce a thorough, evidence-based survey of the current Uptime Kuma codebase that downstream G0 tasks (ADR authoring, target architecture synthesis) will rely on. The survey must identify exactly which tables, endpoints, socket events, monitor types, and scheduler/notification touchpoints will be affected by introducing multi-tenancy, **without proposing any solution** — pure AS-IS documentation.

## Prerequisites/dependencies

- None. This is the entry point for Phase G0 and for the entire plan.
- If any source file referenced below has been moved or renamed since the plan was authored, stop and report the blocker; do not guess an alternative path.

## Owner / recommended agent profile

**Codebase investigator** — read-only researcher. Strong working knowledge of Node.js/Express, Socket.IO, RedBean ORM (used via `redbean-node`), Knex migrations, and Vue 3 structure. Must not modify any source file under `server/`, `src/`, `db/`, or `config/`.

## Exact files and artifacts to create

All outputs go under `docs/architecture/survey/` (this directory does not yet exist — create it):

1. `docs/architecture/survey/README.md` — index + methodology + how to reproduce the survey.
2. `docs/architecture/survey/database-schema.md` — full AS-IS table inventory.
3. `docs/architecture/survey/api-and-socket-events.md` — REST endpoints + Socket.IO events inventory.
4. `docs/architecture/survey/monitoring-engine.md` — scheduler, heartbeat writer, notification dispatcher touchpoints.
5. `docs/architecture/survey/file-impact-map.md` — candidate modules/files likely to need changes per domain (monitor, notification, status page, tag, maintenance, heartbeat, incident, proxy, docker_host, api_key, group, user). **Mark every entry as "candidate" — not a decision.**

No source code is to be created or modified.

## Concrete implementation steps

1. Create the `docs/architecture/survey/` directory and `README.md` with methodology (static analysis only, no runtime probing).
2. **Database schema inventory** (`database-schema.md`):
   - Read `db/knex_init_db.js` and every file under `db/knex_migrations/*.js`.
   - For each table, document: table name, columns (name, type, nullability), indexes, unique constraints, and FK relationships with `ON DELETE` / `ON UPDATE` actions.
   - Cover at minimum: `user`, `monitor`, `notification`, `monitor_notification`, `status_page`, `tag`, `monitor_tag`, `maintenance`, `maintenance_status_page`, `heartbeat`, `incident`, `proxy`, `docker_host`, `api_key`, `remote_browser`, `group` (monitor_group), `stat_minutely`, `stat_daily`, `tag`, and any others discovered while reading.
   - For each table, note in a dedicated column whether a `user_id`-scoped column already exists (this anticipates the future `tenant_id` discussion but does **not** recommend a design).
3. **API + Socket.IO events inventory** (`api-and-socket-events.md`):
   - Enumerate REST routes from `server/routers/api-router.js` and `server/routers/status-page-router.js`, including HTTP method, path, and whether it references `user_id` / `monitor_id` in params or body.
   - Enumerate Socket.IO events from every file under `server/socket-handlers/*.js` and any direct `socket.on(...)` registrations in `server/uptime-kuma-server.js`. Record event name, handler file, and which resource (user/monitor/etc.) it touches.
   - Group endpoints/events by domain for readability.
4. **Monitoring engine touchpoints** (`monitoring-engine.md`):
   - Read `server/uptime-kuma-server.js`, `server/model/monitor.js`, `server/model/heartbeat.js`, `server/notification.js`, and one representative monitor-type implementation under `server/monitor-types/` (e.g., `monitor-type.js` + `tcp.js`).
   - Document: how monitors are loaded into the scheduler, how heartbeats are written, how notifications are dispatched, and where `user_id` (or owner concept) currently influences these flows.
   - List monitor-type implementations present under `server/monitor-types/` (count + filenames only).
5. **File impact map** (`file-impact-map.md`):
   - For each domain listed in the plan's G1 table (`user`, `monitor`, `notification`, `status_page`, `tag`, `maintenance`, `heartbeat`, `incident`, `proxy`, `docker_host`, `api_key`, `monitor_group`), list the backend model file (`server/model/<name>.js`), its socket handler (if any), and frontend entry points (`src/pages/EditMonitor.vue`, `src/pages/StatusPage.vue`, etc. — record real paths found via search).
   - Mark every entry "candidate" because final modification decisions belong to later phases.
6. Cross-link the four documents from `survey/README.md`.
7. In `docs/architecture/survey/README.md`, include a "Reproduce" section listing the read/grep commands used so the survey can be refreshed later.

## Interfaces/contracts and integration points

- **Downstream consumer:** Task G0.02 (ADR authoring) reads the file-impact map and database schema survey as primary input. Task G0.03 (target architecture synthesis) reads all four surveys.
- **Format contract:** All Markdown must use plain tables for inventories and fenced code blocks for file paths. Mermaid diagrams are allowed where useful but not required for this task.
- **Tone contract:** Descriptive AS-IS only. Words like "should", "must migrate", "we will add" are forbidden in survey documents — they belong in ADRs.

## Acceptance criteria

- [ ] `docs/architecture/survey/` exists and contains `README.md`, `database-schema.md`, `api-and-socket-events.md`, `monitoring-engine.md`, `file-impact-map.md`.
- [ ] Every table created by `db/knex_init_db.js` and any migration under `db/knex_migrations/` is listed in `database-schema.md` with columns, types, indexes, and FK actions.
- [ ] Every REST route in `server/routers/*.js` is listed with method, path, and resource-touched flag.
- [ ] Every Socket.IO event handler registered in `server/socket-handlers/*.js` is listed with event name and file.
- [ ] `monitoring-engine.md` identifies (a) where monitors are loaded into the scheduler, (b) where heartbeats are written, (c) where notifications are dispatched — with concrete file paths and function/symbol names.
- [ ] `file-impact-map.md` lists at least one backend file and one frontend file (if applicable) for each of the 12 domains in the plan's G1 table.
- [ ] No source file under `server/`, `src/`, `db/`, or `config/` is modified (verify with `git status --short` showing zero changes outside `docs/`).
- [ ] All findings cite the exact file path (and line number where relevant) so reviewers can verify.

## Verification commands/checks

Run these from the repository root:

```bash
# 1. Confirm no source code was touched by the survey
git status --short | grep -vE '^\?\? docs/' && echo "VIOLATION: non-docs changes detected" || echo "OK: only docs changed"

# 2. Confirm all required survey files exist
for f in README database-schema api-and-socket-events monitoring-engine file-impact-map; do
  test -f "docs/architecture/survey/$f.md" && echo "OK: $f.md" || echo "MISSING: $f.md"
done

# 3. Spot-check schema coverage: every table from knex_init_db must appear in database-schema.md
kuma_tables=$(grep -oE 'createTable\("([a-z_]+)"' db/knex_init_db.js | sed -E 's/.*"([a-z_]+)"/\1/' | sort -u)
for t in $kuma_tables; do
  grep -q "\b$t\b" docs/architecture/survey/database-schema.md && echo "OK table: $t" || echo "MISSING table: $t"
done

# 4. Spot-check socket handler coverage
for f in server/socket-handlers/*.js; do
  base=$(basename "$f")
  grep -q "$base" docs/architecture/survey/api-and-socket-events.md && echo "OK handler: $base" || echo "MISSING handler: $base"
done
```

If any verification command reports `MISSING` or `VIOLATION`, the task is not complete; fix and re-run.

## Reviewer

Uptime Kuma tech lead (or maintainer). Reviewer confirms:
- (a) the inventory is faithful to the actual source,
- (b) no production code was modified,
- (c) the impact map is labeled as candidate/AS-IS (no premature decisions leaked in).

## Explicit out-of-scope

- **Do not** propose the target (TO-BE) architecture, ERD, or data model — that belongs to Task G0.03.
- **Do not** write any ADR — that belongs to Task G0.02.
- **Do not** choose the database (PostgreSQL/MySQL/SQLite), isolation model, or routing strategy — G0.02 owns those decisions.
- **Do not** modify any file under `server/`, `src/`, `db/`, `config/`, `package.json`, or run any migration.
- **Do not** run the dev server or rely on runtime introspection — static analysis only.
- **Do not** enumerate notification providers (`server/notification-providers/`) beyond a single-line reference count — they are addressed in later phases.
