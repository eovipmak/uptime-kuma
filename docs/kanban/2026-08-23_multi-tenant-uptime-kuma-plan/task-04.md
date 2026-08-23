# Task G1.04 — Tenant Schema Foundation (tenant / tenant_user / tenant_invitation)

**Phase:** G1 — Data Model & Migration
**Status:** todo
**Reviewer:** Tech lead / Uptime Kuma maintainer (database domain)

## Objective

Create the three new tenant-root tables defined by the plan's G1 section and the G0 migration contract: `tenant`, `tenant_user`, and `tenant_invitation`. These tables are the foundation that every subsequent G1 task depends on — `tenant` must exist before any other table can gain a `tenant_id` foreign key. This task delivers only the tenant-root tables + their RedBean model files; it does **not** add `tenant_id` to existing tables (that is `task-05`) and does **not** backfill data (that is `task-06`).

## Prerequisites/dependencies

- **Phase G0 fully signed off:** `docs/adr/ADR-0001-database-choice.md`, `docs/adr/ADR-0002-isolation-model.md`, and `docs/architecture/migration-contract.md` must exist and be approved by the reviewer. The "New tables" clause of the migration contract enumerates these three tables with their attributes — implement exactly that contract; do not invent new columns.
- **If any G0 prerequisite artifact is missing or still `Status: Proposed` without reviewer signoff:** stop, report the blocker ("Waiting on G0 ADR-0001/0002 + `migration-contract.md` signoff"), and do not guess column lists.
- No prior G1 task — this is the first G1 task.

## Owner / recommended agent profile

**Migration engineer (database)** — fluent with Knex migrations, SQLite + MariaDB dialect differences (`knex.client.dialect === "sqlite3"`), RedBean-node (`redbean-node`) BeanModel conventions, and the project's migration filename rules (`db/knex_migrations/README.md` + `extra/check-knex-filenames.mjs`).

## Exact files and artifacts to create or modify

1. **Create migration:** `db/knex_migrations/2026-08-23-0000-create-tenant-tables.js`
2. **Create models:** `server/model/tenant.js`, `server/model/tenant_user.js`, `server/model/tenant_invitation.js`
3. **No change** to `db/knex_init_db.js` (its header explicitly forbids adding fields there — all schema additions go via migrations).
4. **No change** to any other model, router, socket handler, or frontend file.

## Concrete implementation steps

1. Re-read `docs/architecture/migration-contract.md`'s "New tables" clause and `docs/adr/ADR-0002-isolation-model.md`'s Decision section. Take the column lists verbatim. If the contract and ADR disagree, stop and report the blocker; do not pick one silently.
2. Create `db/knex_migrations/2026-08-23-0000-create-tenant-tables.js` with `exports.up` and `exports.down` following the template in `db/knex_migrations/README.md`.
3. **`tenant` table (per the migration contract):**
   - `id` (increments, primary key — required by Knex rules).
   - `name` (string, not null — display name).
   - `slug` (string, not null, unique — URL-safe identifier used by routing in G2/G6).
   - `plan` (string, default `'free'` — placeholder, billing in G8).
   - `status` (string, default `'active'` — supports `active|suspended|deleted`).
   - `custom_domain` (string, nullable — populated in G6).
   - `created_at` (datetime, default `knex.fn.now()`).
   - `updated_at` (datetime, default `knex.fn.now()`).
   - Indexes: unique on `slug`; a non-unique index on `custom_domain` for the routing lookup in G2/G6.
4. **`tenant_user` table (N-N join):**
   - `id` (increments, primary key).
   - `tenant_id` (unsigned integer, not null, references `tenant.id`, `onDelete CASCADE`, `onUpdate CASCADE`).
   - `user_id` (unsigned integer, not null, references `user.id`, `onDelete CASCADE`, `onUpdate CASCADE`).
   - `role` (string, not null, default `'viewer'` — placeholder enum; refined in G3 RBAC task).
   - `joined_at` (datetime, default `knex.fn.now()`).
   - Composite unique index on `(tenant_id, user_id)` — a user appears at most once per tenant.
5. **`tenant_invitation` table:**
   - `id` (increments, primary key).
   - `tenant_id` (unsigned integer, not null, references `tenant.id`, `onDelete CASCADE`).
   - `email` (string, not null — invitee email).
   - `token` (string, not null, unique — single-use invite token).
   - `role` (string, not null, default `'viewer'`).
   - `invited_by_user_id` (unsigned integer, nullable, references `user.id`, `onDelete SET NULL`).
   - `expires_at` (datetime, not null — must be enforced at G2 read time, not at DB layer).
   - `accepted_at` (datetime, nullable — `null` until accepted in G2).
   - Index: unique on `token`; non-unique on `(tenant_id, email)` to find pending invites per tenant.
6. **SQLite vs MariaDB dialect handling:** use Knex methods only (no raw SQL); if any constraint semantics differ (e.g., partial indexes), branch on `knex.client.dialect === "sqlite3"` mirroring `2025-12-22-0121-optimize-important-indexes.js` only when truly necessary. Prefer shared Knex methods so both DBs work identically.
7. **`exports.down`:** drop `tenant_invitation`, `tenant_user`, `tenant` in reverse-FK order. Dropping must not touch any other table (those columns are added in `task-05`).
8. **RedBean models:** create `server/model/tenant.js`, `server/model/tenant_user.js`, `server/model/tenant_invitation.js` — each `extends BeanModel` like `server/model/user.js`. For now these are empty shells (auto-mapped beans — RedBean derives table name from filename). Add a JSDoc'd `static async listForUser(userId)` to `tenant_user.js` returning the join query `SELECT t.* FROM tenant_user tu JOIN tenant t ON t.id = tu.tenant_id WHERE tu.user_id = ?` — this is the helper G2 will consume; keep it here so G2's auth refactor can import it. Do **not** add HTTP/socket endpoints in this task.
9. Add JSDoc to every function/method — required by `.eslintrc.js` (`npm run lint` will fail otherwise).

## Interfaces/contracts and integration points

- **Downstream consumers (within G1):**
  - `task-05` adds `tenant_id` columns to other tables with `references tenant.id` — it imports the table name `tenant` (string), no JS contract.
  - `task-06` backfills rows into `tenant` (insert default tenant) and `tenant_user`.
  - `task-08` extends these model classes with relationships (`Monitor.belongsTo(Tenant)` etc.).
- **Downstream consumers (later phases):**
  - G2 (Authentication & Tenant Context) consumes `tenant_user.listForUser(userId)` for the post-login tenant picker and `resolveTenant()` middleware.
  - G3 (RBAC) writes the `role` enum refinement against the existing `tenant_user.role` column — do not change this column's name later.
- **Naming contract:** table names are `snake_case` per Uptime Kuma convention (`db/knex_migrations/README.md`); model filenames are `kebab/snake` matching the existing `server/model/<name>.js` pattern (e.g., `docker_host.js`). Use `tenant.js`, `tenant_user.js`, `tenant_invitation.js`.
- **Filename contract:** the migration filename must pass `extra/check-knex-filenames.mjs` (format `YYYY-MM-DD-HHmm-description.js`). Use `2026-08-23-0000-create-tenant-tables.js`.

## Acceptance criteria

- [ ] `db/knex_migrations/2026-08-23-0000-create-tenant-tables.js` exists and exports `up` and `down`.
- [ ] Filename passes `node ./extra/check-knex-filenames.mjs` (no errors).
- [ ] The `tenant`, `tenant_user`, `tenant_invitation` tables are created by `exports.up` with every column listed in steps 3–5.
- [ ] Foreign keys use `.references("id").inTable("tenant").onDelete("CASCADE")` for `tenant_user.tenant_id` and `tenant_invitation.tenant_id`.
- [ ] `tenant_user.tenant_id` + `tenant_user.user_id` composite unique index exists.
- [ ] `tenant.slug` is unique.
- [ ] `tenant_invitation.token` is unique.
- [ ] `exports.down` drops the three tables in correct FK-avoiding order and touches no other table.
- [ ] `server/model/tenant.js`, `server/model/tenant_user.js`, `server/model/tenant_invitation.js` exist and each `class extends BeanModel`.
- [ ] `tenant_user.js` exports `static async listForUser(userId)` with the documented SQL and JSDoc.
- [ ] `npm run lint` passes with zero warnings on the touched files.
- [ ] No changes outside the files listed in "Exact files and artifacts" (verify via `git status --short`).

## Verification commands/checks

Run from the repository root:

```bash
# 1. Filename format CI gate
node ./extra/check-knex-filenames.mjs

# 2. Lint the new files
npx eslint server/model/tenant.js server/model/tenant_user.js server/model/tenant_invitation.js db/knex_migrations/2026-08-23-0000-create-tenant-tables.js

# 3. Migration runs clean on a fresh SQLite test DB (reuse the existing test-migration harness)
node --test-name-pattern="SQLite migrations run successfully from fresh database" test/backend-test/test-migration.js 2>/dev/null || npm run test-backend -- --test-name-pattern="SQLite migrations"

# 4. Confirm only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(db/knex_migrations/2026-08-23-0000-|server/model/(tenant|tenant_user|tenant_invitation)\.js)' && echo "VIOLATION: unexpected file" || echo "OK: only allowed files changed"

# 5. Schema introspection — count created tables (run on the test DB after migration)
node -e "
const knex = require('knex');
const path = require('path');
(async () => {
  const Dialect = require('knex/lib/dialects/sqlite3/index.js');
  Dialect.prototype._driver = () => require('@louislam/sqlite3');
  const db = knex({ client: Dialect, connection: { filename: ':memory:' }, useNullAsDefault: true });
  const { R } = require('redbean-node'); R.setup(db);
  const { createTables } = require('./db/knex_init_db.js'); await createTables();
  await R.knex.migrate.latest({ directory: path.join('db/knex_migrations') });
  for (const t of ['tenant','tenant_user','tenant_invitation']) {
    const ok = await db.schema.hasTable(t); console.log((ok?'OK':'MISSING')+' table: '+t);
  }
  await db.destroy(); await R.knex.destroy();
})();
"
```

If verification reports `VIOLATION`, `MISSING`, or lint errors, the task is incomplete; fix and re-run.

## Reviewer

Uptime Kuma tech lead (database domain). Reviewer specifically confirms:
- (a) column lists match the G0 `migration-contract.md` exactly (no silent additions/omissions),
- (b) FK `onDelete` actions are correct (`CASCADE` for tenant siblings, `SET NULL` for inviter),
- (c) `slug` uniqueness is enforced and the `custom_domain` index exists (needed by G2/G6 routing),
- (d) rollback drops only the three new tables,
- (e) lint passes.

## Explicit out-of-scope

- **Do not** add `tenant_id` to existing tables (`monitor`, `notification`, `status_page`, …) — that is `task-05`.
- **Do not** create or seed a default tenant — that is `task-06`.
- **Do not** write any HTTP endpoint, socket handler, middleware, or `resolveTenant()` logic — those belong to G2.
- **Do not** implement RBAC permission tables or final role enum — the `role` column here is a placeholder refined in G3.
- **Do not** touch `db/knex_init_db.js` (its header explicitly forbids schema additions there).
- **Do not** alter any existing model (`user.js`, `monitor.js`, …) — handled in `task-08` or later phases.
- **Do not** add billing fields beyond `plan` placeholder — G8 territory.
- **Do not** modify frontend, notification providers, monitor types, or status page router.
