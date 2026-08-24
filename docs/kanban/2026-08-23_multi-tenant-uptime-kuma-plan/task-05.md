# Task G1.05 — tenant_id Columns + Composite Indexes on Existing Tables

**Phase:** G1 — Data Model & Migration
**Status:** todo
**Reviewer:** Tech lead / Uptime Kuma maintainer (database domain)

## Objective

Add a nullable `tenant_id` foreign key column to each of the twelve tenant-scoped domain tables listed in the plan's G1 table, plus the composite indexes mandated by ADR-0002 (`(tenant_id, id)`, `(tenant_id, monitor_id)`, etc.). This is the structural prerequisite for `task-06` (backfill) and for every downstream phase that filters by tenant. The column is **nullable** at the migration layer so empty/default-tenant rows remain valid before `task-06` runs the backfill — `task-06` will populate every existing row and decide whether to flip the column to `NOT NULL`.

> **Coordinator note (G0.03, 2026-08-24):** The example index list in this file predates ADR-0002's final decision. Per `docs/architecture/migration-contract.md` (authoritative), `tenant_id` columns go on the **ten business tables only** (`monitor`, `group`, `proxy`, `docker_host`, `notification`, `status_page`, `maintenance`, `api_key`, `tag`, `remote_browser`). Child/junction tables (`heartbeat`, `stat_*`, `monitor_tag`, `monitor_notification`, `monitor_tls_info`, `incident`, `monitor_group`, …) get **no** redundant `tenant_id` — they use the anchor-subquery pattern, so the `heartbeat` / `monitor_tag` / `monitor_notification` / `incident` entries in the step-5 example list are superseded. Implement exactly what the migration contract enumerates; stop and report if contract and plan text disagree.

## Prerequisites/dependencies

- **Task G1.04** reviewed and approved — the `tenant` table must exist as the FK target. Adding `.references("id").inTable("tenant")` against a non-existent table will fail the migration.
- **If Task G1.04 is not complete:** stop, report the blocker ("Waiting on G1.04 tenant schema foundation"), and do not skip ahead — without `tenant` existing, the FK constraint is unenforceable.
- G0's `docs/adr/ADR-0002-isolation-model.md` and `docs/architecture/migration-contract.md` "Tables gaining `tenant_id`" clause must enumerate exactly which tables to touch.

## Owner / recommended agent profile

**Migration engineer (database)** — same profile as `task-04`. Familiar with Knex `alterTable`, composite index naming conventions, SQLite vs MariaDB `alterTable` semantics (SQLite cannot drop columns without table rebuild on older versions, but the project uses `@louislam/sqlite3` which supports modern DDL through Knex's rebuild mechanism for `alter` operations).

## Exact files and artifacts to create or modify

1. **Create migration:** `db/knex_migrations/2026-08-23-0001-add-tenant-id-columns.js`
2. **Modify (comment-only):** `db/knex_init_db.js` — add a comment block next to each affected `createTable` call stating that `tenant_id` is added by migration `2026-08-23-0001` per multi-tenant plan, so a fresh MariaDB install knows where the column comes from. **Do not add schema code to `knex_init_db.js`** — its header warning is explicit ("IF YOU NEED TO ADD FIELDS, ADD IT TO ./db/knex_migrations").
3. **No change** to any model file (relationships are wired in `task-08`), router, socket handler, or frontend.

## Concrete implementation steps

1. Re-read `docs/architecture/migration-contract.md`. Its "Tables gaining `tenant_id`" clause enumerates the exact set. Implement that list verbatim; if the contract omits a table the plan mentions, stop and report — do not diverge.
2. The **expected tables** (subject to contract verification — these are the plan's G1 list, confirm against the contract):
   - `monitor`, `notification`, `status_page`, `tag`, `maintenance`, `heartbeat`, `incident`, `proxy`, `docker_host`, `api_key`, `group` (monitor_group)
   - Plus any additional tables the contract explicitly lists.
3. For **each** affected table, in `exports.up`:
   - `table.integer("tenant_id").unsigned().nullable().references("id").inTable("tenant").onDelete("CASCADE").onUpdate("CASCADE")`.
   - The column is **nullable** at this stage so the migration does not break a populated DB before `task-06` backfills. The reviewer may demand `NOT NULL` after backfill — that change (if any) is owned by `task-06` as a follow-up migration `2026-08-23-0002`.
   - Note: tables where `user_id` already points to `user.id` (e.g., `monitor.user_id`, `proxy.user_id`, `docker_host.user_id`) should retain `user_id` as the per-user owner link; `tenant_id` is the per-tenant membership link. Both are needed.
4. Composite indexes (per ADR-0002 and plan G1):
   - `monitor`: index `(tenant_id, id)`, `(tenant_id, user_id)`.
   - `heartbeat`: index `(tenant_id, monitor_id)` — keeps the existing `monitor_id` index, adds a tenant-partitioned one.
   - `monitor_tag`: index `(tenant_id, monitor_id)`, `(tenant_id, tag_id)`.
   - `monitor_notification`: index `(tenant_id, monitor_id)`, `(tenant_id, notification_id)`.
   - `tag`, `notification`, `status_page`, `incident`, `proxy`, `docker_host`, `api_key`, `group`, `maintenance`: index `(tenant_id, id)`.
   - Verify the table exists before indexing (some tables like `monitor_tag` / `monitor_notification` are created by migrations ending later in the chain; ensure they exist on a fresh DB by migration ordering — Knex runs migrations in filename-sorted order, so name this file `2026-08-23-0001-…` so it runs after 0000 and after all 2023–2026 table-creators that precede it alphabetically).
5. **SQLite vs MariaDB:** prefer Knex schema-builder methods; branch on `knex.client.dialect === "sqlite3"` only if a specific index feature (e.g., partial indexes) is needed — otherwise shared methods handle both dialects. Index names must be unique within each table and explicit (pass a name to `table.index([...], "name")`) to avoid SQLite auto-naming collisions.
6. **`exports.down`:** for each table, `alterTable` to `dropColumn("tenant_id")` and drop each composite index. Use `try/catch` per dialect: SQLite's older `dropColumn` may rebuild the table — Knex handles this transparently; do **not** write raw table-recreation SQL.
7. **Comment-only update to `db/knex_init_db.js`:** for each `createTable(...)` call (e.g., the `monitor` block), insert a one-line comment like `// tenant_id is added by migration 2026-08-23-0001 per multi-tenant plan; see docs/adr/ADR-0002`. Do **not** add code there.
8. Ensure `exports.up` and `exports.down` are idempotent where reasonable (e.g., `dropIndex` with explicit names won't fail on second run; on SQLite, use `knex.raw("DROP INDEX IF EXISTS …")` for safety).

## Interfaces/contracts and integration points

- **Downstream consumer (within G1):** `task-06` writes the backfill INSERT/UPDATE that populates `tenant_id` for every existing row. The column being nullable now is precisely what allows `task-06` to run safely on a populated DB.
- **Downstream consumers (later phases):** G2's `resolveTenant` middleware will inject `tenant_id` into every query; G4's repository wrapper relies on these columns + indexes existing.
- **FK target contract:** every new `tenant_id` references `tenant.id` via `.references("id").inTable("tenant")` — no other target.
- **Naming contract:** composite index names follow the existing Uptime Kuma style `<table>_<cols>_index` (e.g., `monitor_tenant_id_id_index`); pass names explicitly so both dialects agree.

## Acceptance criteria

- [ ] `db/knex_migrations/2026-08-23-0001-add-tenant-id-columns.js` exists and exports `up` and `down`.
- [ ] Filename passes `node ./extra/check-knex-filenames.mjs`.
- [ ] Every table listed in the G0 migration contract's "Tables gaining `tenant_id`" clause has a `tenant_id` column added in `exports.up`.
- [ ] Every new `tenant_id` is a FK to `tenant.id` with `onDelete CASCADE` / `onUpdate CASCADE`.
- [ ] Every composite index listed in step 4 is created in `exports.up` and dropped in `exports.down`.
- [ ] `exports.down` removes the columns and indexes from each affected table and touches no other table.
- [ ] `db/knex_init_db.js` contains the comment notes but no schema code in the affected `createTable` blocks (e.g., no `table.integer("tenant_id")` calls inside `knex_init_db.js`).
- [ ] Migration runs on a fresh SQLite DB without error (existing test harness).
- [ ] Migration runs on a fresh MariaDB container — this is the harder dialect; if the existing `test-migration.js` MariaDB test is available, let it run.
- [ ] `npm run lint` passes on the updated files.
- [ ] No changes outside the two files named above.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Filename format CI gate (covers both 0000 and 0001)
node ./extra/check-knex-filenames.mjs

# 2. Lint
npx eslint db/knex_migrations/2026-08-23-0001-add-tenant-id-columns.js db/knex_init_db.js

# 3. Migration smoke test (fresh SQLite) — runs all migrations up to and including this one
node --test-name-pattern="SQLite migrations run successfully from fresh database" test/backend-test/test-migration.js 2>/dev/null || npm run test-backend

# 4. Column presence on a fresh DB
node -e "
const knex = require('knex'); const path = require('path');
(async () => {
  const Dialect = require('knex/lib/dialects/sqlite3/index.js');
  Dialect.prototype._driver = () => require('@louislam/sqlite3');
  const db = knex({ client: Dialect, connection: { filename: ':memory:' }, useNullAsDefault: true });
  const { R } = require('redbean-node'); R.setup(db);
  const { createTables } = require('./db/knex_init_db.js'); await createTables();
  await R.knex.migrate.latest({ directory: path.join('db/knex_migrations') });
  const tables = ['monitor','notification','status_page','tag','maintenance','heartbeat','incident','proxy','docker_host','api_key','group'];
  for (const t of tables) {
    const hasCol = await db.schema.hasColumn(t, 'tenant_id');
    console.log((hasCol?'OK':'MISSING')+' tenant_id on '+t);
  }
  await db.destroy(); await R.knex.destroy();
})();
"

# 5. knex_init_db.js got no schema code (only comments) — grep should find zero createColumn calls for tenant_id
grep -nE 'table\.(integer|string|datetime)\(\s*[\"'\'']tenant_id[\"'\'']' db/knex_init_db.js && echo 'VIOLATION: tenant_id schema added to knex_init_db.js' || echo 'OK: knex_init_db.js has only comments'

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(db/knex_migrations/2026-08-23-0001-|db/knex_init_db\.js)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Uptime Kuma tech lead (database domain). Reviewer specifically confirms:
- (a) the table list matches the migration contract (no silent additions or omissions),
- (b) every FK targets `tenant.id` `onDelete CASCADE` (so off-boarding a tenant purges its rows),
- (c) composite indexes match ADR-0002 (`(tenant_id, id)`, `(tenant_id, monitor_id)`, etc.) and use explicit names,
- (d) column is nullable now and the NOT-NULL tightening decision is explicitly delegated to `task-06`,
- (e) `knex_init_db.js` gained comments only, no schema code.

## Explicit out-of-scope

- **Do not** populate `tenant_id` for existing rows — that is `task-06`.
- **Do not** flip `tenant_id` to `NOT NULL` in this task — `task-06` owns the post-backfill constraint change if any.
- **Do not** wire RedBean relationships on `Monitor`, `Notification`, etc. — that is `task-08`.
- **Do not** modify any HTTP endpoint, socket handler, or frontend — they belong to G2/G7.
- **Do not** add `tenant_id` to tables like `stat_minutely`, `stat_daily` unless the G0 contract explicitly says so — those aggregate tables derive tenant from `monitor_id`, not their own `tenant_id` (note: the contract may still require it for partition scans — implement whatever the contract says, nothing else).
- **Do not** write cache key prefixes or the G4 repository wrapper.
- **Do not** touch `server/model/user.js` for tenant membership — that is captured via `tenant_user` in `task-04`.
