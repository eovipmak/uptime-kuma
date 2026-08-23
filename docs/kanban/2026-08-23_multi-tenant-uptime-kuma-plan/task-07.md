# Task G1.07 — Seed Script for 3 Demo Tenants (Dev/Staging Only)

**Phase:** G1 — Data Model & Migration
**Status:** todo
**Reviewer:** Dev-experience lead / Uptime Kuma maintainer

## Objective

Provide a one-command developer seed that creates **three demo tenants** (Acme, XYZ, 123) with realistic data — monitors, notifications, tags, and tenant_user assignments to the admin user — so developers and QA can exercise multi-tenant UX without manual SQL. This is the "Seed data mẫu: 3 tenant demo (Acme, XYZ, 123)" deliverable from the plan's G1 section.

**This seed is gated behind a non-production guard:** it must never run against a production or populated DB. The script self-refuses to run unless the environment signals dev/staging.

## Prerequisites/dependencies

- **Task G1.04, Task G1.05, Task G1.06** all reviewed and approved. The demo seed inserts into `tenant`, `tenant_user`, plus the tenant-scoped tables (`monitor`, `notification`, `tag`, `monitor_tag`, …) that gained `tenant_id` in task-05 and were backfilled in task-06. Without those, inserts fail FK / null-constraint violations.
- **If any of 04/05/06 is incomplete:** stop, report the blocker, and do not seed partial data.
- This task is **parallel-safe with `task-08`** — file ownership sets are disjoint (see Interfaces).

## Owner / recommended agent profile

**Dev-experience / farmer engineer** — comfortable writing seed scripts under Knex/RedBean, idempotent insert helpers, and environment guards. Respects the project's "never commit `data/`" rule.

## Exact files and artifacts to create or modify

1. **Create:** `db/seed/multi-tenant-demo.js` — the main seed script.
2. **Create:** `db/seed/README.md` — usage and safety notes.
3. **Create:** `extra/run-tenant-demo-seed.mjs` — thin runner (matches the project's `extra/*.mjs` convention for one-shot scripts like `check-knex-filenames.mjs`).
4. **Add** a `"seed:tenant-demo"` entry to `"scripts"` in `package.json` that calls the runner; do not move or modify other script entries.
5. **No change** to any model, router, socket handler, migration, or frontend file.

## Concrete implementation steps

1. Re-read `docs/architecture/migration-contract.md` "3 demo tenants" clause (if present) and the plan's G1 section. Three tenants are: `Acme` (slug `acme`), `XYZ` (slug `xyz`), `123` (slug `123-org` — slugs must start with a letter, never a digit, for URL routing in G6).
2. **Environment guard (mandatory):** the script must check `process.env.NODE_ENV === "development" || process.env.UPTIME_KUMA_DEMO_SEED === "1"`. If neither, exit non-zero with `console.error("Refusing to run outside dev/demo. Set UPTIME_KUMA_DEMO_SEED=1 to override.")`. Never prompt.
3. **Idempotency:** each insert uses `knex("...").where({ slug/unique }).first()` to detect existence. Re-running the seed is a no-op and logs " Tenant `acme` already exists; skipping" for each.
4. **Seed content per tenant** (small but realistic):
   - One `tenant` row (slug, name, plan=`free`, status=`active`).
   - A `tenant_user` row assigning the existing admin user (looked up via `user` where `username = <admin>`—if no admin exists, exit with a clear message that the seed requires the setup wizard done first).
   - Two `monitor` rows per tenant (one `http`, one `tcp` or `ping`) with `tenant_id` set.
   - One `notification` row per tenant (any provider type defined in `server/notification.js`—use the simplest, e.g., webhook SMTP stub config) with `tenant_id` set.
   - Two `tag` rows per tenant, plus two `monitor_tag` rows linking tags to monitors (with `tenant_id` set per task-05).
5. **Data ownership:** every row created in this seed must have `tenant_id` set to the correct tenant — never null. This is the demo enforcement of rule "every query filters by `tenant_id`".
6. **The runner in `extra/run-tenant-demo-seed.mjs`**:
   - Loads the same Knex/RedBean config as `test/mock-testdb.js` (look at its `Database.initDataDir` + `Database.connect` calls) but pointed at the **production data dir** unless `UPTIME_KUMA_DEMO_SEED_DB` points elsewhere.
   - Calls `seed()` from `db/seed/multi-tenant-demo.js`, prints a summary table of created counts, then closes the connection.
7. **`package.json` script change:** add `"seed:tenant-demo": "node extra/run-tenant-demo-seed.mjs"` exactly; do not add peer-dep-breaking or version-bumping changes — verify with `node extra/check-package-json.mjs` afterwards (no `^` allowed).
8. **README:** document the env vars, the dev-only guard, what gets created, and how to reset (`rm data/kuma.db` for SQLite or `DROP DATABASE` for MariaDB). Note that seeding on a populated prod DB is blocked by the guard.
9. **JSDoc** on every exported function in the seed module.

## Interfaces/contracts and integration points

- **File-ownership-disjoint from `task-08`:** task-08 edits `server/model/*.js` and `test/backend-test/test-tenant-migration.js`; this task edits `db/seed/`, `extra/run-tenant-demo-seed.mjs`, and `package.json`. No overlap → safe to run in parallel after task-06.
- **Unchanged contracts:** no new HTTP endpoints, no socket events, no model method modifications.
- **API contract:** consumed by developers manually via `npm run seed:tenant-demo`. Not invoked by the app at runtime. Not invoked by tests in G1 (task-08 owns migration tests).
- **Reusable in later phases:** G7's UI onboarding flow can demo against this data; G11 E2E tests in `test/e2e/` may consume this seed as a fixture.

## Acceptance criteria

- [ ] `db/seed/multi-tenant-demo.js`, `db/seed/README.md`, `extra/run-tenant-demo-seed.mjs` exist.
- [ ] `package.json` gains exactly one new script entry `"seed:tenant-demo"` and no other modifications; `node extra/check-package-json.mjs` still passes.
- [ ] Running `UPTIME_KUMA_DEMO_SEED=1 npm run seed:tenant-demo` against a clean install with an admin user creates the three tenants and the noted sample rows; counts in summary print match expectations (3 tenants, 6 monitors, 3 notifications, 6 tags, 6 monitor_tags, 3 tenant_user rows).
- [ ] Re-running the seed is a no-op (idempotent — no duplicate rows, no errors).
- [ ] Running `npm run seed:tenant-demo` without the env var exits non-zero with the documented refusal message and **makes zero writes**.
- [ ] Every seeded row has `tenant_id` set (no `NULL` on any tenant-scoped column).
- [ ] If the admin user does not exist (setup wizard not run), the seed exits with a clear actionable message.
- [ ] `npm run lint` passes on `db/seed/multi-tenant-demo.js` and `extra/run-tenant-demo-seed.mjs`.
- [ ] No changes to `server/`, `src/`, `db/knex_migrations/`, `db/knex_init_db.js`, `config/`.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Package-json gate (no caret versions introduced)
node extra/check-package-json.mjs

# 2. Lint
npx eslint db/seed/multi-tenant-demo.js extra/run-tenant-demo-seed.mjs

# 3. Refusal guard without env var
npm run seed:tenant-demo 2>&1 | grep -q "Refusing to run" && echo "OK guard" || echo "MISSING guard"
# Critical: ensure zero DB writes happened — check git/gitignored data dir for changes
git status --short data/ | wc -l

# 4. Smoke seed against a clean demo DB (use a throwaway path)
UPTIME_KUMA_DEMO_SEED_DB=./data/demo-seed-test.db UPTIME_KUMA_DEMO_SEED=1 npm run seed:tenant-demo
# Verify counts
node -e "
const knex = require('knex'); const path = require('path');
(async () => {
  const Dialect = require('knex/lib/dialects/sqlite3/index.js');
  Dialect.prototype._driver = () => require('@louislam/sqlite3');
  const db = knex({ client: Dialect, connection: { filename: './data/demo-seed-test.db' }, useNullAsDefault: true });
  for (const q of [
    ['tenant',3],['monitor',6],['notification',3],['tag',6],['monitor_tag',6],['tenant_user',3]
  ]) {
    const n = (await db(q[0]).count('* as c'))[0].c;
    console.log((n===q[1]?'OK':'BAD')+' '+q[0]+'='+n+' expected '+q[1]);
  }
  await db.destroy();
})();
"
# cleanup
rm -f ./data/demo-seed-test.db

# 5. Idempotency
UPTIME_KUMA_DEMO_SEED_DB=./data/demo-seed-test.db UPTIME_KUMA_DEMO_SEED=1 npm run seed:tenant-demo
UPTIME_KUMA_DEMO_SEED_DB=./data/demo-seed-test.db UPTIME_KUMA_DEMO_SEED=1 npm run seed:tenant-demo
# Counts must be unchanged from step 4; verify with the same node -e snippet.
rm -f ./data/demo-seed-test.db

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(db/seed/|extra/run-tenant-demo-seed\.mjs|package\.json)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Dev-experience lead / maintainer. Reviewer specifically confirms:
- (a) the dev-only guard refuses production runs and produces zero writes when refused,
- (b) the seed is idempotent,
- (c) every seeded row has `tenant_id` set,
- (d) `package.json` change is minimal and CI gate (`check-package-json.mjs`) still passes,
- (e) the script degrades gracefully when the admin user does not exist.

## Explicit out-of-scope

- **Do not** add the seed to the app's runtime startup path — it is a manual developer tool, not auto-run on boot.
- **Do not** modify migrations, `task-04/05/06` content, or models (task-08).
- **Do not** backfill data into `heartbeat`/`stat_*` — the demo seed creates monitors but lets the running app populate heartbeats naturally; seeding fake heartbeat time series belongs to a future load-test fixture (G11).
- **Do not** add notification provider logic — the seed uses existing provider config shapes.
- **Do not** add billing/pricing fields beyond the `plan = "free"` placeholder.
- **Do not** change CI workflows to auto-run the seed (per `.github/workflows/auto-test.yml`) — running this seed in CI belongs to a separate decision in G11.
- **Do not** commit the demo SQLite DB file under `data/` (it is gitignored; verify with `git check-ignore data/demo-seed-test.db`).
