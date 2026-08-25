# Task G4.17 — Base Repository + Tenant-Safe Query Wrapper (Contract Originator)

**Phase:** G4 — Repository / Query Layer
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Backend lead / Uptime Kuma maintainer (G4 entry-point signoff)

## Objective

Build the **tenant-safe query layer** that all G4 rewrites (tasks 18, 19, 20) consume. The existing codebase leans on `redbean-node` (`R.findOne`, `R.find`, `R.exec`, `R.findAll`, `R.dispense`) scoped by `user_id` — the G1 multi-tenant migration already added `tenant_id` columns to every tenant-owned table (`task-05`), so the missing piece is a wrapper that **injects `tenant_id` into every query** at the data-access layer. This task ships the wrapper module (no call-site rewrites here — those are tasks 18, 19, 20) plus the ESLint rule that catches unscoped queries in future code.

This task freezes the contract:
- The wrapper's surface (`findOneForTenant`, `findForTenant`, `execForTenant`, `findAllForTenant`, `dispenseForTenant`).
- The cache-key namespace prefix `tenant:${tenantId}:` (consumed by G10 Redis, defined here).
- The ESLint rule identifier (so 18/19/20's rewrites can leave a `// eslint-disable` rationale only where a documented exemption exists).

## Prerequisites/dependencies

- **Phase G3 fully approved** (tasks 13/14/15/16):
  - `task-13` — `ROLES`, `PERMISSIONS`, `buildAbilityFor` shipped; RBAC middleware and socket helpers available.
  - `task-14` — every socket mutation handler has a `checkPermission(...)` after `checkLogin(socket)` (so `socket.tenantID` is guaranteed non-null at the moment a repository call is reached).
  - `task-15` — every HTTP business route has `requirePermission(...)` after G2's `requireTenantContext()` (so `req.user.tenantId` is guaranteed non-null when a handler calls the repository).
  - `task-16` — RBAC test suite passes; G3 closed.
- **Phase G2 fully approved** — `socket.tenantID` and `req.user.tenantId` are set before any business logic runs (G2 `task-09`/`task-10`/`task-11`).
- **Phase G1 fully approved** (tasks 04/05/06/08):
  - `task-04` — `tenant`, `tenant_user`, `tenant_invitation` tables exist.
  - `task-05` — `tenant_id` column added to every tenant-owned table (with FK + `ON DELETE CASCADE` per G1 contract).
  - `task-06` — default tenant + backfill of existing rows to `tenant_id = default`.
  - `task-08` — model relationships wired; `listForTenant(tenantId)` helpers exist for each model.
- **If any G2/G3/G1 task is incomplete:** stop, report the blocker ("Waiting on G3 (13/14/15/16) + G1 (04/05/06/08) signoff"), do not write a query wrapper against an unverified schema or an unverified tenant-context provider.

## Owner / recommended agent profile

**Backend data-access architect** — fluent with `redbean-node` (`R.findOne/find/findAll/exec/dispense`), Knex migrations, ESLint custom rules (`@eslint/plugin-kit` or the project's existing `@eslint/eslintrc` rule-authoring patterns), and Node.js test runner. Must understand that the existing single-tenant codebase scopes queries by `user_id` — that pattern stays for *ownership* (e.g., "this monitor was created by user X") but is **supplemented** by `tenant_id` for *isolation* (every tenant-owned row belongs to exactly one tenant).

## Exact files and artifacts to create or modify

1. **Create** `server/repository/tenant-repo.js` — the tenant-safe wrapper. Exports:
   - `findOneForTenant(table, whereFragment, params, tenantId)` — shadow of `R.findOne(table, "${baseWhere} AND tenant_id = ?", [...params, tenantId])`.
   - `findForTenant(table, whereFragment, params, tenantId, extraSql = "")` — same shape for `R.find` (the trailing `extraSql` carries `ORDER BY`/`LIMIT` like the existing call sites).
   - `findAllForTenant(table, whereFragment, params, tenantId, extraSql = "")` — shadow of `R.findAll`.
   - `execForTenant(sql, params, tenantId, opts)` — for `R.exec` UPDATE/DELETE statements, append a `tenant_id = ?` clause AND (optionally, when the WHERE clause doesn't already mention the primary key) require `opts.requireId` to enforce a WHERE-by-id-AND-tenant guard.
   - `dispenseForTenant(table, tenantId)` — calls `R.dispense(table)` then sets `bean.tenant_id = tenantId` so the row is born in the right tenant.
   - `TenantScopedQueryBuilder` — a small builder class for the rare aggregate/static-method queries (COUNT, max-id) that need to append the tenant filter; used by `task-19` for the trickier static methods in `server/model/monitor.js` (`getPreviousHeartbeat`, `getMonitorList`, etc.).
2. **Create** `server/repository/cache-namespace.js` — exports `tenantCacheKey(tenantId, key)` returning `tenant:${tenantId}:${key}` and `tenantKeyToScope(key)` (the inverse, used by G10 to scan keys for a tenant on off-board cleanup). The Redis-backed cache itself does not exist yet (G10 owns the adapter); this is the **key contract** that hand-written string concatenations in the codebase (`"monitor:" + id` style) start to migrate to.
3. **Create** `server/repository/index.js` — re-export the wrapper for ergonomic imports: `const { findOneForTenant, findForTenant, execForTenant, dispenseForTenant, tenantCacheKey } = require("../repository");`.
4. **Create** `server/repository/eslint-rules/require-tenant-scope.js` — a custom ESLint rule that flags `R.findOne(` / `R.find(` / `R.exec(` / `R.findAll(` call sites **without either** a `tenant_id =` token **or** an inline `// eslint-disable-next-line require-tenant-scope` with a documented rationale. The rule's `meta.messages` is `missingTenantScope: "Data-access call on {{table}} lacks a tenant_id filter; use findOneForTenant/findForTenant/execForTenant or document an exemption."`.
5. **Create** `.eslintrc-rules.cjs` (or extend the project's existing `.eslintrc.js` — confirm which before adding) — register the rule under the project's existing `extends`/`rules` block so `npm run lint` surfaces violations. The rule ships as **warn** in this task to avoid breaking the existing un-migrated call sites; **task-18**/**task-19** flip the warn→error on files they own as they migrate.
6. **No source code rewrite** in this task — call-site migrations are 18 (socket handlers) and 19 (models + uptime-kuma-server). This task only ships the contract.
7. **Modify** `package.json` — add a `lint:rbac` / `lint:tenant` sub-script convenience? **No** — keep the existing `lint` script; the rule auto-runs with `npm run lint`. No new dependencies (ESLint plugin authoring uses ESLint's built-in `RuleCreator` API, no new dep). If the project's ESLint major (confirm version) requires `@eslint/plugin-kit` for typed rule authors, add it as devDep with `--legacy-peer-deps` and document the rationale.

## Concrete implementation steps

1. Re-read `docs/kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-05.md` (G1 — which tables got `tenant_id`), and the `R.findOne/R.find/R.exec/R.dispense` signature surface via `grep -rn 'R\.\(findOne\|find\|exec\|dispense\|findAll\)(' server/ | head -40`. The wrapper must mirror every primitive the codebase actually uses — no inventing new ones.
2. **`server/repository/tenant-repo.js`:**
   ```js
   const { R } = require("redbean-node");
   const { log } = require("../../src/util");

   /**
    * Tenant-scoped findOne — appends tenant_id filter to every query.
    * @param {string} table the RedBean table name (e.g., "monitor")
    * @param {string} whereFragment existing WHERE fragment; *must not* already include tenant_id
    * @param {Array} params params matching the whereFragment
    * @param {number} tenantId the calling tenant context (from req.user.tenantId or socket.tenantID)
    * @returns {Promise<Bean|null>}
    */
   async function findOneForTenant(table, whereFragment, params, tenantId) {
       if (tenantId === undefined || tenantId === null) {
           throw new Error(`findOneForTenant(${table}): tenantId required; got ${tenantId}`);
       }
       const merged = `(${whereFragment}) AND tenant_id = ?`;
       return await R.findOne(table, merged, [...params, tenantId]);
   }
   // ... findForTenant, findAllForTenant, execForTenant, dispenseForTenant follow the same shape ...
   module.exports = { findOneForTenant, findForTenant, findAllForTenant, execForTenant, dispenseForTenant, TenantScopedQueryBuilder };
   ```
   - **Critical:** the wrapper throws on missing `tenantId` — never silently defaults to default-tenant; if the RBAC layer failed to set context, the data layer must fail loudly (a tenant-aware query against `undefined` would silently cross-leak). Log a structured warning via `log.warn` so 18/19's missing context surfaces as a 500, not a leak.
   - For `execForTenant`: if the SQL is an `UPDATE ... WHERE id = ?` shape, append ` AND tenant_id = ?`; if it's a multi-row `UPDATE`, the wrapper refuses without `opts.requireId = false` (intentional escape hatch, sparingly used).
   - For `dispenseForTenant(table, tenantId)`: returns `R.dispense(table)` with `bean.tenant_id = tenantId` preset — a *new* row that forgot to set its tenant would be a leak otherwise; this eliminates the class of bugs at construction.
3. **`server/repository/cache-namespace.js`:**
   ```js
   const tenantCacheKey = (tenantId, key) => `tenant:${tenantId}:${key}`;
   const tenantKeyToScope = (key) => {
       const m = /^tenant:(\d+):/.exec(key || "");
       return m ? Number(m[1]) : null;
   };
   module.exports = { tenantCacheKey, tenantKeyToScope };
   ```
   - The shape `tenant:${tenantId}:${key}` is the **frozen contract** G10 will use for the Redis adapter. No call-site uses this in this task — `task-19` may apply it where the codebase already hand-writes cache keys (`apicache` middleware options, `Settings.get` cache); if any such site exists, mark with a `// TODO(G10): migrate to tenantCacheKey when Redis adapter ships` comment rather than refactoring.
4. **`server/repository/eslint-rules/require-tenant-scope.js`:**
   - Use ESLint's `CallExpression` visitor; match `R.findOne` / `R.find` / `R.exec` / `R.findAll` (any member-expression callee where the object is `R`).
   - Inspect the first argument (the table string) and the second argument (the where fragment or SQL) via AST string-literal extraction; if the fragment contains the token `tenant_id`, skip; otherwise report `missingTenantScope`.
   - Allow opt-out via inline `eslint-disable-next-line require-tenant-scope` — the migration in 18/19 will remove these as it rewrites.
5. Register the rule in `server/repository/index.js` re-export for ergonomics; ESLint plugin registration lives in `server/repository/eslint-rules/index.js` (an ESLint plugin shims `require-tenant-scope` as `uptime-kuma/require-tenant-scope`).
6. Wire the plugin into `.eslintrc.js` (or `.cjs` — confirm the project's current config):
   ```js
   extends: ["plugin:uptime-kuma/recommended"],  // if extracted; or
   rules: { "uptime-kuma/require-tenant-scope": "warn" }
   ```
   Ship as `warn` for this task so the existing un-migrated call sites don't break CI — turn to `error` per-file as 18/19 migrate.
7. JSDoc every export; `.eslintrc.js` (4-space indent, double quotes, semicolons).
8. **Do not** rewrite any call site — that is 18/19/20.

## Interfaces/contracts and integration points

- **Upstream consumer (within G4):**
  - `task-18` (socket-handler rewrites) imports `findOneForTenant`/`findForTenant`/`execForTenant` and replaces `socket.userID`-scoped queries with the wrapper pulled from `socket.tenantID`.
  - `task-19` (model + uptime-kuma-server rewrites) imports the same surface for static-method migrations; the `TenantScopedQueryBuilder` exists specifically for the aggregate/static queries (`getPreviousHeartbeat`, `getMonitorJSONList`, `loadMaintenanceList`) that don't fit the simple `findOne/find` shape.
  - `task-20` (cross-tenant IDOR tests + cache) imports `tenantCacheKey` and `findOneForTenant` for the IDOR test fixtures.
- **Downstream consumers (later phases):**
  - G5 (Monitoring engine) — `findOneForTenant` is what the scheduler uses to load the next-due monitors per tenant; the wrapper is the guarantee that the engine never polls another tenant.
  - G6 (Status page) — `findOneForTenant` resolves a public status page by slug **after** the G2 router resolved the requesting tenant; the slug lookup is scoped by tenant so two tenants can both have a `slug = "main"` status page.
  - G9 (Security/audit) — wraps `findOneForTenant`calls with the audit-trail hook from `task-16`'s `audit-hook.js` surface so cross-tenant-writes are logged.
  - G10 (DevOps) — uses `tenantCacheKey` for the Redis adapter's key namespacing; the contract here is what G10's memcache/redis wiring will follow.
- **Frozen contract (by this task):**
  - Wrapper signatures exactly as listed above.
  - Cache-key shape: `tenant:${tenantId}:${key}`.
  - ESLint rule identifier: `uptime-kuma/require-tenant-scope`.
- **Behavioral parity contract:**
  - Default-tenant deploy: existing single-tenant rows have `tenant_id = default` (from G1 `task-06`); queries that previously matched by `user_id` now match by `(user_id, tenant_id=default)` — same result set, no regression observable to the user.
  - Multi-tenant deploy: switching tenants now produces the tenant's actual monitor list (the broken-as-of-G2 behavior, fixed by 18 + 19).

## Acceptance criteria

- [ ] `server/repository/tenant-repo.js` exports `findOneForTenant`, `findForTenant`, `findAllForTenant`, `execForTenant`, `dispenseForTenant`, `TenantScopedQueryBuilder` — all throw on missing `tenantId`, all with JSDoc.
- [ ] `server/repository/cache-namespace.js` exports `tenantCacheKey` and `tenantKeyToScope` with JSDoc; namespace shape `tenant:${tenantId}:${key}`.
- [ ] `server/repository/index.js` re-exports the surface.
- [ ] `server/repository/eslint-rules/require-tenant-scope.js` exists, registered in the project's ESLint config, and reports `missingTenantScope` for any `R.findOne/R.find/R.exec/R.findAll` call without a `tenant_id` token in the where fragment OR an inline `eslint-disable` rationale.
- [ ] The ESLint rule ships as `warn` (not `error`) so the existing un-migrated call sites don't break CI; documented in a comment that 18/19 flip to `error` per-file when migrating.
- [ ] `npm run lint` passes on every new file (the new files are themselves clean — `warn` count from existing call sites is expected and **does not fail** this task; the turn-to-error is per-file in 18/19).
- [ ] A simple unit test exists in `test/backend-test/test-repo-tenant.js` (this task ships three cases: ✓ `findOneForTenant` with valid tenantId returns rows that match; ✗ `findOneForTenant` with `tenantId = undefined` throws; ✔ `dispenseForTenant` presets `bean.tenant_id`); this is the surface smoke — exhaustive coverage belongs to `task-20`.
- [ ] No call-site rewrites in this task — verify with `grep -rn 'findOneForTenant\|findForTenant\|execForTenant\|dispenseForTenant' server/socket-handlers/ server/model/ server/server.js server/client.js` returning only this task's exports, not usages.
- [ ] No changes outside `server/repository/`, the ESLint config file, `test/backend-test/test-repo-tenant.js`, `package.json`/`package-lock.json` (only if `@eslint/plugin-kit` was added as devDep).

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint the new files (must pass; existing-call-site warnings don't count against this task)
npx eslint server/repository/ test/backend-test/test-repo-tenant.js

# 2. Wrapper exports present
node -e "
const w = require('./server/repository');
['findOneForTenant','findForTenant','findAllForTenant','execForTenant','dispenseForTenant','TenantScopedQueryBuilder','tenantCacheKey'].forEach(k => {
  console.log((w[k] ? 'OK' : 'MISSING')+' export: '+k);
});
console.log('cache key for tenant 7, \"monitor:42\":', w.tenantCacheKey(7, 'monitor:42'));
console.log('scope from key:', w.tenantKeyToScope('tenant:9:foo'));
"

# 3. Wrapper throws on missing tenant
node -e "
const w = require('./server/repository');
const p = w.findOneForTenant('monitor', 'id = ?', [1], undefined);
p.then(() => { console.error('FAIL: did not throw'); process.exit(1); })
 .catch((e) => console.log('OK throws on missing tenantId:', e.message));
"

# 4. dispenseForTenant presets bean.tenant_id
node -e "
(async () => {
  const { R } = require('redbean-node');
  await R.setup({ client: 'sqlite3', connection: { filename: ':memory:' } });
  const w = require('./server/repository');
  const bean = w.dispenseForTenant('monitor', 42);
  console.log(bean.tenant_id === 42 ? 'OK preset tenant_id' : 'FAIL preset');
  await R.close();
})();
"

# 5. ESLint rule registered
grep -nE 'require-tenant-scope' .eslintrc.js .eslintrc.cjs 2>/dev/null

# 6. The rule warns on an unscoped call site — quick sanity
cat > /tmp/unscoped-test.js <<'EOF'
const { R } = require("redbean-node");
async function f() { return await R.findOne("monitor", "id = ?", [1]); }
EOF
npx eslint --rule '{"uptime-kuma/require-tenant-scope":"warn"}' --resolve-plugins-relative-to . /tmp/unscoped-test.js 2>&1 | grep -q missingTenantScope && echo 'OK rule fires' || echo 'FAIL rule did not fire'

# 7. Smoke test runs
node --test test/backend-test/test-repo-tenant.js

# 8. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/repository/|\.eslintrc|test/backend-test/test-repo-tenant\.js|package\.json|package-lock\.json)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Backend lead / Uptime Kuma maintainer — **this is the G4 entry-point signoff**. Specifically confirms:
- (a) the wrapper throws on missing `tenantId` (no silent default-to-default-tenant — that would be a leak vector),
- (b) the `execForTenant` UPDATE/DELETE guard refuses to run a tenant-owned-table UPDATE without a tenant_id clause (or an explicit `requireId = false` escape hatch with reviewer oversight),
- (c) `dispenseForTenant` presets `bean.tenant_id` so future row creation can't forget the column,
- (d) the ESLint rule fires on unscoped `R.findOne/R.find/R.exec/R.findAll` — catching future regressions,
- (e) the cache-key namespace shape is the same one G10 will adopt for the Redis adapter,
- (f) the wrapper mirrors the redbean-node primitive surface exactly (no missing `findAll`/`exec` shadow causing 18/19 to fall back to直接 R calls).

## Explicit out-of-scope

- **Do not** rewrite any call site — that is `task-18` (socket handlers) and `task-19` (models + uptime-kuma-server). This task ships the wrapper + rule only.
- **Do not** introduce a Redis cache client here — `task-20` rewrites cache-key strings wherever the codebase hand-writes them, but the Redis-backed adapter belongs to G10. This task only freezes the **key contract**.
- **Do not** add resource-owner (per-user within a tenant) checks beyond `tenant_id` — RBAC gates by role (G3); ownership-by-user checks are out-of-scope for ALL of G4 unless the plan calls them out (it doesn't; the plan's "Base Repository tự động inject `tenant_id`" is tenant-level only).
- **Do not** change the `tenant_id` schema (G1 owns it). If a G4 rewrite would need a missing index or FK, raise a blocker against G1 `task-05`, don't add migrations here.
- **Do not** make the ESLint rule `error` globally in this task — that breaks CI for every still-un-migrated call site; the flip is per-file in 18/19 as they migrate.
- **Do not** add a deprecated-`R.findOne` alias or shim — call sites migrate to the wrapper; no compat shim that would let a future author accidentally bypass the wrapper.
- **Do not** write the IDOR test suite — that is `task-20`. Here, only the surface smoke (three cases) for the wrapper itself.
- **Do not** re-thread existing migrations or seed data — G1 owns database state.
- **Do not** introduce a second ORM layer (`prisma`/`sequelize`) — the plan said "Prisma middleware / Sequelize hooks / Knex builder wrapper" as possibilities; the codebase is on `redbean-node`, so the wrapper is layered on top of RedBean, not a replacement (least-surprise for the existing handlers).
- **Do not** change the `setting` table queries — the global settings table (`server/settings.js`) is **cross-tenant** (system-wide config like `jwtSecret`, `entryPage`); the wrapper must not retro-fit a `tenant_id` there. Document that `setting` is a known exemption (`require-tenant-scope` will fire on `Settings.get`'s `R.findOne`; an inline `eslint-disable` with rationale "setting is cross-tenant system config" is the correct interpretation — call it out in the rule's `meta.docs`).

## Coordinator status
- Status: completed
- Completed by: Oracle (CTO) — implementation delivered via KUM-33 (PR author: shared eovipmak account), reviewed and merged by CTO
- Completed at: 2026-08-25T11:25:00Z
- Verification:
  - `npm run lint` → 0 errors / 229 warnings (new `uptime-kuma/require-tenant-scope` rule flagging un-migrated call sites as designed; warn→error flips owned by task-18/19)
  - `npm run tsc` → clean
  - `node --test test/backend-test/test-repo-tenant.js` → 9/9 pass, 0 fail (temp-file SQLite, in-process redbean wiring — D-016 compliant, no containers)
  - Contract review against this spec: fail-loud `assertTenantId` (no silent default-tenant), caller fragments may not reference `tenant_id`, `execForTenant` refuses WHERE-less/multi-row mutations without `{ requireId: false }` + strips trailing `;`, param ordering verified, `findAllForTenant` leads with AND for redbean's `" 1=1 "` prefix
- Commit or artifact reference: PR [#44](https://github.com/eovipmak/uptime-kuma/pull/44) merged (squash) → master; branch `feat/g4-17-base-repository`
- Notes:
  - Accepted deviation: plugin registered as local `file:` devDependency (`eslint-plugin-uptime-kuma`) instead of adding `@eslint/plugin-kit`; zero new external packages, rationale documented in PR description.
  - Frozen contract intact for consumers: task-18 (socket handlers), task-19 (models + server core), task-20 (IDOR tests) may now build on `require("../repository")`.
