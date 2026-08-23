# Task G1.08 — Model Relationships + Migration Tests (up/down)

**Phase:** G1 — Data Model & Migration
**Status:** todo
**Reviewer:** Backend lead / Uptime Kuma maintainer

## Objective

Wire the RedBean-node relationship helpers on the existing domain models (`Monitor`, `Notification`, `Tag`, `Maintenance`, `Heartbeat`, `Incident`, `Proxy`, `DockerHost`, `ApiKey`, `Group`, `StatusPage`) so that `model.tenant_id` is readable and the relationships are queryable from RedBean, and add a backend test that **proves the full G1 migration chain (up → down → up) is idempotent and loses no data on rollback**. This task also produces the "ERD updated" artifact required for G1's Definition of Done by recording a short Markdown reference to the realized schema (G0 produced the static TO-BE ERD; this task only verifies the realized schema matches).

## Prerequisites/dependencies

- **Task G1.04, Task G1.05, Task G1.06** all reviewed and approved — the tenant tables, `tenant_id` columns, and default-tenant seeding must all be in place. The test in this task exercises the full migration chain end-to-end; partial completion will fail it.
- **If any of 04/05/06 is incomplete:** stop, report the blocker, and do not write tests against a moving target.
- This task is **parallel-safe with `task-07`** — file ownership sets are disjoint.

## Owner / recommended agent profile

**Backend engineer (redbean-node)** — deep knowledge of RedBean's `BeanModel` derivation, `R.find`, `R.store`, `R.exec` patterns; comfortable with the Node.js test runner (`node:test`) used by `test/backend-test/test-migration.js`.

## Exact files and artifacts to create or modify

1. **Modify (light touch)** `server/model/monitor.js`, `server/model/notification.js`, `server/model/tag.js`, `server/model/maintenance.js`, `server/model/heartbeat.js`, `server/model/incident.js`, `server/model/proxy.js`, `server/model/docker_host.js`, `server/model/api_key.js`, `server/model/group.js`, `server/model/status_page.js`: add a `tenantId` getter and a `static async listForTenant(tenantId, userId)` helper on each model that scopes the `findMany` query by `tenant_id`. Do not break the existing public methods.
2. **Create** `test/backend-test/test-tenant-migration.js` — the G1-specific migration test.
3. **Create** `docs/architecture/erd-realized.md` — a short Markdown note stating the realized schema matches the G0 `erd-to-be.md` (or listing any delta with rationale). Includes the same mermaid `erDiagram` block but annotated "as-implemented".
4. **No change** to routers, socket-handlers, frontend, migrations (04-06 already wrote them), or `db/seed/`.

## Concrete implementation steps

1. **RedBean model touch-ups** (per model file listed above):
   - The BeanModel auto-maps columns to properties — `tenant_id` is already accessible as `this.tenant_id` (camelCased by RedBean). Add a small JSDoc'd getter on each model, e.g., `get tenantId() { return this.tenant_id; }` — convenience only, not required by RedBean; do it for API consistency.
   - Add `static async listForTenant(tenantId)` returning `await R.findMany("<model>", " tenant_id = ? ORDER BY id", [ tenantId ])`. Keep the existing finders intact.
   - **Do not add cross-tenant queries anywhere** — every list method in this task is `tenant_id`-scoped. This is consistent with the plan's rule "every query filters by `tenant_id`" even though G4 will add the global enforcement.
   - For `Monitor`, also add `static async listForTenantAndUser(tenantId, userId)` because the existing `Monitor` model already filters by `user_id` in some methods (preserve that behavior).
2. **Migration test** `test/backend-test/test-tenant-migration.js` using `node:test`:
   - **Fixture 1 (fresh DB, no data):** initialize via `test/mock-testdb.js` (SQLite), run `R.knex.migrate.latest()`, assert the three tenant tables exist and `tenant`, `tenant_user`, `tenant_invitation` are queryable; assert every G1-listed table has a `tenant_id` column; assert the default tenant row exists (slug=`default`); assert the existing admin user has a `tenant_user` row with role `tenant_admin`.
   - **Fixture 2 (populated DB, pre-existing data):** use `TestDB` from `test/mock-testdb.js` to bootstrap, then insert one `user` + one `monitor` before running migrations; run migrations; assert that the monitor's `tenant_id` equals the default tenant's id; capture the monitor's row id.
   - **Rollback safety:** on Fixture 2, call `R.knex.migrate.rollback()` (or `migrate.down()` to the previous batch) and assert (a) the monitor row still exists with the same id, (b) `tenant_id IS NULL`, (c) no rows were deleted from `user` or `monitor` — **the existing `test-migration.js` does not cover rollback-with-no-data-loss for tenant backfill; this test fills that gap**.
   - **Re-migrate (idempotency):** on Fixture 2 after rollback, call `migrate.latest()` again; counts must be identical (one user, one monitor, one tenant_user, one default tenant). Final state == initial-after-first-migration state.
   - Use `describe`/`test` patterns; name tests so `npm run test-backend` picks them up. Reference `test-migration.js` for the container/SQLite pattern.
   - The test must run on SQLite; an additional MariaDB variant is welcome but optional (MariaDB bootstrap requires `testcontainers` — adds runtime cost; defer if CI is tight).
3. **ERD realized** (`docs/architecture/erd-realized.md`): a short Markdown file that:
   - Reproduces the `erDiagram` block from `docs/architecture/erd-to-be.md` (G0's deliverable).
   - Annotates "as-implemented" with the migration filenames that produced each entity (e.g., `tenant` — `2026-08-23-0000-create-tenant-tables.js`).
   - Records any divergence between the realized schema and the contract (e.g., if `tenant_id` was left nullable per task-06's reviewer decision); each divergence has a one-line reason.
   - Cross-links the G0 ERD as the source-of-truth design and pins this file as the realized-state snapshot at G1 close.
4. **Lint and run**: ensure `npm run lint` and the new test pass.

## Interfaces/contracts and integration points

- **File-ownership-disjoint from `task-07`:** task-07 edits `db/seed/`, `extra/`, `package.json`; this task edits `server/model/*.js`, `test/backend-test/test-tenant-migration.js`, `docs/architecture/erd-realized.md`. Safe to run in parallel.
- **Downstream consumers (later phases):**
  - G2 (Authentication & Tenant Context) imports the `listForTenant` helpers when serving the tenant picker after login and when resolving tenant for a request.
  - G4 (Repository Layer) wraps these model methods in a tenant-safe base repository; the per-model helpers here are a stepping stone, not a final API — G4 will decide the canonical query API.
  - G11 (Testing & QA) extends this test fixture pattern for cross-tenant IDOR tests.
- **Test contract:** running `node --test test/backend-test/test-tenant-migration.js` (or `npm run test-backend`) must pass on SQLite without manual setup.
- **Backward-compatibility contract:** the existing public methods on each modified model (e.g., `Monitor.toJSON`, `Monitor.getTags`) must continue to work identically — verify by running the existing `test/backend-test/monitor*` tests; if any break, stop and report.

## Acceptance criteria

- [ ] Every listed model file has `get tenantId()` and `static async listForTenant(tenantId)` with JSDoc; existing methods unchanged.
- [ ] `test/backend-test/test-tenant-migration.js` exists and registers tests for: (a) fresh DB schema, (b) populated-DB backfill, (c) rollback-without-data-loss, (d) re-migrate idempotency.
- [ ] `npm run test-backend` runs the new test and it passes on SQLite.
- [ ] The rollback test asserts row counts on `user` and `monitor` are identical before-and-after (no deletions).
- [ ] No existing `test/backend-test/*.test.js` breaks after the model touch-ups (verify by running the full `npm run test-backend`).
- [ ] `docs/architecture/erd-realized.md` exists, mirrors G0's TO-BE ERD, annotates migration filenames, and lists any divergence with rationale.
- [ ] `npm run lint` passes on every modified file.
- [ ] No changes outside `server/model/`, `test/backend-test/`, and `docs/architecture/erd-realized.md`.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint the modified files
npx eslint server/model/monitor.js server/model/notification.js server/model/tag.js server/model/maintenance.js server/model/heartbeat.js server/model/incident.js server/model/proxy.js server/model/docker_host.js server/model/api_key.js server/model/group.js server/model/status_page.js test/backend-test/test-tenant-migration.js docs/architecture/erd-realized.md

# 2. Run the new test only
node --test test/backend-test/test-tenant-migration.js

# 3. Make sure existing backend tests still pass (regression gate)
npm run test-backend

# 4. Each model has the new helper — quick grep check
for f in monitor notification tag maintenance heartbeat incident proxy docker_host api_key group status_page; do
  grep -qE "static\s+async\s+listForTenant" "server/model/$f.js" && echo "OK helper: $f" || echo "MISSING helper: $f"
done

# 5. ERD realized references G0 TO-BE ERD
grep -q "erd-to-be" docs/architecture/erd-realized.md && echo "OK cross-link" || echo "MISSING cross-link"
grep -qE '```mermaid' docs/architecture/erd-realized.md && echo "OK mermaid" || echo "MISSING mermaid"

# 6. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/model/(monitor|notification|tag|maintenance|heartbeat|incident|proxy|docker_host|api_key|group|status_page)\.js|test/backend-test/test-tenant-migration\.js|docs/architecture/erd-realized\.md)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Backend lead / Uptime Kuma maintainer. Reviewer specifically confirms:
- (a) the rollback test really proves no business data is lost (this is G1's central safety claim, per the plan's "Rollback không mất data" Definition of Done),
- (b) the existing public methods on each touched model are unchanged (no silent regressions for the rest of the app),
- (c) the realized ERD matches the G0 TO-BE ERD or every divergence is documented with a rationale,
- (d) the test runs cleanly via `npm run test-backend` on a fresh checkout (no manual setup beyond the existing test harness).

## Explicit out-of-scope

- **Do not** add HTTP/socket endpoints that consume the new `listForTenant` helpers — that is G2's job.
- **Do not** write the G4 base repository or the ESLint rule for `tenant_id` filters — that is G4's job; this task only adds per-model helpers as the stepping stone.
- **Do not** modify migrations 0000/0001/0002 — they were finalized in tasks 04/05/06; if the tests reveal a migration bug, report it as a blocker rather than editing another task's deliverable.
- **Do not** add RBAC permission logic to the models — placeholder `role` column is read as a string only; G3 enforces.
- **Do not** touch the demo seed (`task-07`) — file ownership disjoint.
- **Do not** add OpenTelemetry / audit logging — G9 territory.
- **Do not** write e2e Playwright tests — that is G11.
