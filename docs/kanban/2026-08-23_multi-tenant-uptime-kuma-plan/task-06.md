# Task G1.06 — Default-Tenant Seeding & Backward-Compatible Backfill

**Phase:** G1 — Data Model & Migration
**Status:** completed
**Estimate:** M (per plan template "Format output task chuẩn")
**Reviewer:** Tech lead / Uptime Kuma maintainer (database domain)

## Objective

Make existing single-tenant Uptime Kuma deployments keep working untouched after G0 + task-04 + task-05 land. To do that, this task creates a **default tenant** (slug `default`, used for backfill) and a migration that assigns every pre-existing row to that tenant. Backward compatibility — the plan's mandatory rule — depends on this task: any row missing `tenant_id` would otherwise be invisible or filtered as cross-tenant noise.

This task also owns the **optional NOT-NULL tightening** decision: once backfill is verified, the follow-up migration may flip `tenant_id` to `NOT NULL` **only if** the reviewer signs off; otherwise leave it nullable and enforce at the application layer (G4).

## Prerequisites/dependencies

- **Task G1.04** reviewed and approved — `tenant` and `tenant_user` tables must exist.
- **Task G1.05** reviewed and approved — `tenant_id` column must exist on every affected table.
- **No existing runtime schema** beyond what G0's `knex_init_db.js` + migrations produce. If your DB has drifted (e.g., manual additions), stop and report — do not attempt to auto-detect drift.
- **If either prerequisite is incomplete:** stop, report the blocker, and do not run any backfill against an unknown schema.

## Owner / recommended agent profile

**Migration engineer (database)** — same profile as task-04/05. Must be comfortable writing **idempotent** migrations (a re-run on an already-backfilled DB must be a no-op, not an error).

## Exact files and artifacts to create or modify

1. **Create migration:** `db/knex_migrations/2026-08-23-0002-seed-default-tenant.js`
2. **Optional follow-up migration (if reviewer-approved):** `db/knex_migrations/2026-08-23-0003-tighten-tenant-id-not-null.js` — created only if the reviewer signs off the NOT-NULL transition plan.
3. **Modify:** `server/setup-database.js` — add a small **post-migration** hook `await seedDefaultTenantIfEmpty()` that idempotently creates the default tenant row if missing, so a fresh install (with no existing data) is immediately multi-tenant ready. The app already calls `Database.patch()` after migrations; plug into that lifecycle, do **not** add a new HTTP route.

## Concrete implementation steps

1. Re-read `docs/architecture/migration-contract.md` "Default tenant seeding" and "Rollback" clauses. Implement exactly what those clauses say; this task is the realization of those clauses.
2. Create `db/knex_migrations/2026-08-23-0002-seed-default-tenant.js`.
3. **`exports.up` — insert default tenant (idempotent):**
   - Use `knex("tenant").where({ slug: "default" }).first()` to detect existence; if `null`, `INSERT` the default tenant row with `{ name: "Default Tenant", slug: "default", plan: "free", status: "active", custom_domain: null }`.
   - Capture the inserted (or existing) `tenant.id` for use in the backfill.
4. **`exports.up` — backfill `tenant_id` on every tenant-scoped row:**
   - For each table that gained `tenant_id` in task-05, run `UPDATE <table> SET tenant_id = <default_tenant_id> WHERE tenant_id IS NULL`.
   - Do this with `knex("<table>").whereNull("tenant_id").update({ tenant_id: defaultTenantId })` — Knex method, no raw SQL.
   - Order matters only for the seed of `tenant_user` (see step 5); the column-backfill order does not matter because there are no intra-row FKs between `tenant_id` columns.
5. **`exports.up` — seed `tenant_user` rows for every existing admin user:** for each row in `user` that should be a tenant admin of the default tenant (every `user` with `active = 1`, or, if the plan demands a narrower rule, follow the contract), insert a `tenant_user` row `{ tenant_id: defaultTenantId, user_id: <uid>, role: "tenant_admin" }` only if it does not already exist (`INSERT ... ON CONFLICT DO NOTHING` via Knex — use the `(tenant_id, user_id)` unique index to short-circuit duplicates).
   - The role "tenant_admin" is the placeholder chosen to match G3's role matrix (Tenant Admin is the highest per-tenant role per the plan).
6. **`exports.down` — must not lose real data:**
   - Set `tenant_id = NULL` on every row of every backfilled table.
   - Delete the `tenant_user` rows that belong to the default tenant (they were created by this migration, so deletion is non-destructive).
   - Delete the `default` tenant row.
   - **Do not** drop the `tenant_id` column (that is task-05's `exports.down` responsibility) — `exports.down` here restores the pre-backfill state, not the pre-column state.
   - Verify the order: `UPDATE tenant_id = NULL` first, then `DELETE tenant_user`, then `DELETE tenant` — avoiding FK violations on the `tenant_user.tenant_id` constraint.
7. **Idempotency verification:** re-running `exports.up` must be a no-op because the `where slug = "default"` guard short-circuits the insert and `whereNull("tenant_id")` short-circuits the updates. Write a manual test of this.
8. **Setup hook in `server/setup-database.js`:**
   - Locate where migrations are applied (the file's existing `patch()`/`Database.patch()` path).
   - After migrations complete, call a new `seedDefaultTenantIfEmpty()` that runs the equivalent of step 3+4 but only for the default tenant row creation (the backfill in step 4 runs only once via the migration; the hook only ensures the tenant row exists on fresh installs that run `knex_init_db.js` then jump to the latest migration).
   - Add JSDoc; this is critical-path bootstrap code.
   - If the function signature or call location is not obvious, document the chosen integration point in the file header comment for reviewers.
9. **NOT-NULL tightening (optional, conditional):** if and only if the reviewer signs off in writing, create `2026-08-23-0003-tighten-tenant-id-not-null.js` that runs `alterTable` to revert `tenant_id` to `notNullable()` **after** verifying (in `exports.up`) that zero rows have `tenant_id IS NULL`. The `exports.down` returns it to nullable. If the reviewer declines, leave `task-05`'s nullable state and skip this file entirely.
10. Add JSDoc everywhere. Follow `.eslintrc.js` (4-space indent, double quotes, semicolons).

## Interfaces/contracts and integration points

- **Downstream consumer (within G1):** `task-07` (3 demo tenants seed) assumes the default-tenant exists to anchor the demo. `task-08` reads the backfilled state to validate realized schema in tests.
- **Downstream consumers (later phases):** G2 (Authentication & Tenant Context) — when a single-tenant user logs in, the tenant picker returns `[{ slug: "default", role: "tenant_admin" }]` because of step 5. G4 (Repository Layer) assumes every row has a `tenant_id`; the backfill is what makes that assumption trustworthy.
- **Backward compatibility contract:** after this task ships, a pre-existing single-tenant deployment must boot and operate unchanged: no feature flag needed, no manual `tenant_id` setting, no schema error.
- **Rollback contract:** `exports.down` must restore the pre-migration state exactly; it must not delete user data, monitors, heartbeats, etc. — only the `tenant_user` rows that this migration inserted and the `default` tenant row.

## Acceptance criteria

- [ ] `db/knex_migrations/2026-08-23-0002-seed-default-tenant.js` exists and exports `up` and `down`.
- [ ] Filename passes `node ./extra/check-knex-filenames.mjs`.
- [ ] `exports.up` creates the default tenant (idempotent via `slug = "default"` guard).
- [ ] `exports.up` backfills `tenant_id` on every table task-05 touched, using `whereNull("tenant_id")`.
- [ ] `exports.up` creates `tenant_user` rows for every existing admin user with role `tenant_admin` (idempotent against the `(tenant_id, user_id)` unique index).
- [ ] `exports.down` sets `tenant_id = NULL` on every per-row backfill, deletes the `tenant_user` rows created here, deletes the `default` tenant — in correct FK-safe order, **without deleting any user/monitor/notification rows**.
- [ ] Re-running `exports.up` is a no-op (tested manually and reported in the verification summary).
- [ ] `server/setup-database.js` calls `seedDefaultTenantIfEmpty()` after migrations complete.
- [ ] On a populated SQLite test DB seeded with one user + one monitor (use the existing `test/mock-testdb.js` helper), running migrations and rollback produces no row count change on `user`/`monitor`.
- [ ] `npm run lint` passes on the new files and the modified `setup-database.js`.
- [ ] No changes outside the three paths above.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Filename gate (now covers 0000/0001/0002 — and 0003 if created)
node ./extra/check-knex-filenames.mjs

# 2. Lint the new and modified files
npx eslint db/knex_migrations/2026-08-23-0002-seed-default-tenant.js server/setup-database.js
[ -f db/knex_migrations/2026-08-23-0003-tighten-tenant-id-not-null.js ] && npx eslint $_

# 3. Fresh-fixture test: populated DB seeded with user+monitor, then migrate, then rollback, then re-migrate; row counts identical
node -e "
require('./test/mock-testdb.js'); // not directly executable — adapt to a manual script if needed
"

# 4. Migration + rollback shrinks nothing on real data (use a fixture)
#    Recommend adding an explicit test in task-08's test file rather than inline here.
#    Manual smoke:
#    a. SQLite with one user + one monitor inserted.
#    b. R.knex.migrate.latest() -> assert monitor.tenant_id === default.id
#    c. R.knex.migrate.rollback() -> assert monitor.tenant_id IS NULL and the monitor row still exists (count preserved).
#    d. R.knex.migrate.latest() again -> idempotent: same counts.

# 5. Setup hook fires
grep -n "seedDefaultTenantIfEmpty" server/setup-database.js && echo "OK hook referenced" || echo "MISSING hook"

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(db/knex_migrations/2026-08-23-000[23]-|server/setup-database\.js)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Uptime Kuma tech lead (database domain) — **this is the central backward-compatibility gate for the entire multi-tenant initiative**. Reviewer specifically confirms:
- (a) rollback does not delete any business data (the single most important safety property),
- (b) re-running on an already-backfilled DB is a no-op,
- (c) every pre-existing admin user becomes `tenant_admin` of the default tenant (correct per plan G3 matrix),
- (d) the NOT-NULL tightening decision is documented (signed off **or** explicitly deferred with rationale),
- (e) `setup-database.js` hook fires after migrations on fresh installs.

## Explicit out-of-scope

- **Do not** seed the 3 demo tenants (Acme, XYZ, 123) — that is `task-07`.
- **Do not** write any HTTP/socket API for managing tenants — that is G2.
- **Do not** implement RBAC verification — the `tenant_admin` role here is a string placeholder; G3 enforces it.
- **Do not** modify `user.js`, `monitor.js`, or other models — those live in `task-08`.
- **Do not** add a feature flag for "single-tenant mode" — the plan's isolation model assumes one default tenant absorbs legacy data; no mode switch required.
- **Do not** backfill `stat_minutely` / `stat_daily` if they do not have a `tenant_id` column (decided in task-05 per the contract) — if they do, this task must backfill them too via `monitor.tenant_id`, which can be derived per row via a join.
- **Do not** implement audit logging for the backfill — G9 territory.

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-25T03:30:00Z
- Verification: Full functional verification on SQLite fixtures via the repo's own knex + @louislam/sqlite3 stack (61 assertions, all passing). (1) Populated upgrade path: legacy baseline (knex_init_db) + pre-G1 migration ledger seeded, 2 users (incl. one `active = 0` — contract Clause D.3 backfills every existing user) and rows in all ten Clause-B tables + heartbeat child row; full chain migrate.latest → default tenant created (`Default Tenant`/`default`/free/active), every table's rows have `tenant_id = default`, zero business-row loss, heartbeat untouched (no tenant_id column per ADR-0002). (2) Idempotency: re-running exports.up directly is a no-op (1 tenant, no duplicate memberships). (3) Rollback safety: exports.down detaches only rows pointing at the default tenant, deletes only its memberships then the tenant row; business counts identical before/after. (4) down→up cycle lands on identical logical state. (5) Fresh install: empty DB through the chain seeds the default tenant with zero memberships; simulated post-migration admin creation + `seedDefaultTenantIfEmpty()` hook attaches it as `tenant_admin`. Gates: `node ./extra/check-knex-filenames.mjs` OK; `npx eslint` clean on both files; repo `lint:js` 0 errors (72 pre-existing warnings); `npm run tsc` exit 0; backend suite has 34 failures confirmed byte-identical on master (missing oracledb/postgres drivers, RDAP/external services — environmental, not a regression). Scope: PR touches exactly the two allowed paths.
- Decisions recorded: **NOT-NULL tightening DEFERRED to G4** (contract open item C1) — current application code still INSERTs business rows without tenant_id until the G4 wrapper enforces injection; flipping now would break every such write and violate backward compat. No `2026-08-23-0003-tighten-tenant-id-not-null.js` created. **Integration-point note (task step 8):** knex migrations run inside `Database.patch()` (server/database.js, outside this task's allowed paths); `server/setup-database.js` therefore exposes `seedDefaultTenantIfEmpty()` as the documented post-migration seeding hook (consumed by G2/task-09's fresh-install admin setup), reusing the migration module's exported implementation — no duplicated seed logic, and SetupDatabase itself never touches a DB connection before configuration completes.
- Commit or artifact reference: PR #12 (squash-merged e96533e7417bfcfd560e81067dc1de1467547c4b), branch `feat/g1-06-default-tenant-backfill`.
