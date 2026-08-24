# Codebase & Database Schema Survey — G0.01 (AS-IS)

Evidence-based inventory of the Uptime Kuma codebase produced for the multi-tenancy groundwork (plan: `docs/kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-01.md`). **Everything here is descriptive AS-IS documentation**: it records what exists today. It contains no solutions, no recommendations, and no target architecture — those belong to later ADR/architecture tasks.

## Methodology

- **Static analysis only.** No runtime probing: no dev server, no migrations, no database connections were run.
- Sources read directly:
  - `db/knex_init_db.js` and all 55 `.js` migration files under `db/knex_migrations/` (plus the directory's own `README.md`)
  - `server/routers/api-router.js`, `server/routers/status-page-router.js` (the only two routers; verified by directory listing)
  - all 10 files under `server/socket-handlers/`, plus direct `socket.on(...)` registrations inside `io.on("connection")` in `server/server.js` (note: `server/uptime-kuma-server.js` registers none itself)
  - `server/model/monitor.js`, `server/model/heartbeat.js`, `server/notification.js`, `server/uptime-kuma-server.js`, `server/server.js`, `server/client.js`, `server/auth.js`, `server/jobs.js`, `server/jobs/*.js`, `server/uptime-calculator.js`
  - frontend entry points under `src/pages/`, `src/components/`, `src/mixins/` located via search
- All findings cite exact file paths and line numbers so reviewers can verify each claim against the source.

## Documents

| Document | Contents |
| --- | --- |
| [`database-schema.md`](./database-schema.md) | Full table inventory from `db/knex_init_db.js` + every migration: columns/types/nullability/indexes/uniques/FK actions, plus a per-table "has existing `user_id` column" summary. 27 table definitions found (26 surviving + `maintenance_timeslot`, created then dropped during init). |
| [`api-and-socket-events.md`](./api-and-socket-events.md) | Every REST route in `server/routers/*.js` with method/path and user_id/monitor_id reference flags; every Socket.IO client→server event from `server/socket-handlers/*.js` and the main connection handler in `server/server.js`; server→client emit catalog; socket room topology. |
| [`monitoring-engine.md`](./monitoring-engine.md) | Where monitors load into the scheduler, where heartbeats are written (two writers), where stat aggregates are upserted, where notifications dispatch, background retention jobs, monitor-type registry (26 files / 25 implementations + base class). |
| [`file-impact-map.md`](./file-impact-map.md) | Per-domain map (user, monitor, notification, status_page, tag, maintenance, heartbeat, incident, proxy, docker_host, api_key, monitor_group): backend model, socket handler, REST surface, frontend entry points. **Every entry is marked candidate** — not a decision. |

## Key AS-IS facts (pointers only)

- Ownership today is a single nullable `monitor.user_id` FK (`ON DELETE SET NULL`) plus `user_id` columns on `api_key`, `docker_host`, `proxy`, `notification`, `maintenance`, `remote_browser`. Tables like `status_page`, `tag`, `group`, `heartbeat`, `stat_*`, `incident` carry no owner column (details in `database-schema.md`).
- The socket layer already scopes traffic through one room per user id (`socket.join(user.id)` in `afterLogin`, `server/server.js:1759-1761`; live beats emitted `io.to(this.user_id)` at `server/model/monitor.js:1059`).
- Heartbeats have exactly two writers: the scheduled beat loop (`Monitor.start()` → `beat()` → `R.store(bean)`, `server/model/monitor.js:1067`) and the unauthenticated push route (`server/routers/api-router.js:125`).
- Notification dispatch is resolved per monitor via the `monitor_notification` join (`server/model/monitor.js:1526-1530`) and delegated through `Notification.send` (`server/notification.js:254`) to one of 107 provider files.

## Reproduce

All commands run from the repository root.

```bash
# --- Schema ---
# Table creations in init script
grep -nE 'createTable\("' db/knex_init_db.js
# Converted-patch ALTERs in init script
grep -nE 'schema\.table\("' db/knex_init_db.js
# Migration files and their operations
ls db/knex_migrations/
for f in db/knex_migrations/*.js; do echo "== $f"; grep -nE 'createTable|alterTable|renameColumn|dropColumn|dropTable' "$f"; done
# Constraints
grep -rnE 'references\(|\.index\(|\.unique\(' db/knex_init_db.js db/knex_migrations/

# --- REST routes ---
grep -nE '^router\.(get|post|put|delete|all)\(' server/routers/*.js

# --- Socket events ---
grep -rn 'socket\.on(' server/socket-handlers/
grep -n 'socket\.on(' server/server.js
grep -rno 'emit("[a-zA-Z]*"' server --include=*.js | sort -u   # server->client emits

# --- Monitoring engine ---
sed -n '/^async function startMonitors/,/^}/p' server/server.js
grep -n "async start(io)" server/model/monitor.js
grep -n 'dispense("heartbeat")\|R.store(bean)\|sendNotification\|isImportantForNotification' server/model/monitor.js server/routers/api-router.js
grep -n "static async send(" server/notification.js
ls server/monitor-types/ | wc -l && ls server/monitor-types/
ls server/notification-providers/ | wc -l

# --- Frontend entry points ---
ls src/pages/ src/components/ src/mixins/
```

## Survey scope notes

- Notification providers are counted (107 files under `server/notification-providers/`) but not enumerated, per task scope.
- SQLite-vs-MariaDB dialect branches inside migrations are noted where they change schema outcomes (e.g. partial indexes on `heartbeat`, analytics_type enum rebuild on `status_page`).
- No file outside `docs/architecture/survey/` was created or modified by this survey.
