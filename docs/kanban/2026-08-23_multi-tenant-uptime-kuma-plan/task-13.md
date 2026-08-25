# Task G3.13 — RBAC Foundation Module (Roles, Permissions, Policy, Middleware)

**Phase:** G3 — RBAC (Role-Based Access Control)
**Status:** todo
**Reviewer:** Security lead / Uptime Kuma maintainer (G3 entry-point signoff)

## Objective

Build the reusable RBAC foundation that the rest of G3 (03.14 socket enforcement, 03.15 HTTP enforcement, 03.16 tests/audit hook) and later phases (G7 UI ability gating, G9 audit log, G5 monitoring quota enforcement) consume. This task **freezes** the role matrix, the permission enum, and the policy schema as the single source of truth. **No call-site enforcement here** — that is tasks 14/15. This task produces the contract only, plus the Express middleware and socket helper that 14/15 will thread into existing handlers.

This is the contract originator for Phase G3: every later G3 task reads the role/permission map defined here.

## Prerequisites/dependencies

- **Phase G2 fully approved** (all four tasks: `task-09`, `task-10`, `task-11`, `task-12`):
  - `task-09` — `User.createJWT(user, tenantId, role, jwtSecret)` issues the `role` claim; `socket.tenantID` is set in `afterLogin`; `auth.listTenantsForUser(userId)` returns `role` per tenant per `tenant_user`.
  - `task-10` — `resolveTenant()` sets `req.user.tenantId` and `req.user.role` (the JWT's `role` claim, membership-resolved at switch time). `requireTenantContext()` guarantees these are present on every guarded `/api` route.
  - `task-11` — `checkLogin(socket)` now asserts both `socket.userID` and `socket.tenantID`; `socket.role` is set on the socket during `afterLogin` (the socket-side mirror of `req.user.role`).
  - `task-12` — role-value is a string from the G1 `tenant_user.role` column; integration tests confirm login/switch/logout/invalid-tenant work.
- **G1 task-04 / 06 / 08** approved — `tenant_user` has `role` for `(tenant_id, user_id)`; the default tenant backfill in `task-06` sets `role = "tenant_admin"` for the existing admin.
- **If any G2 task or G1 task is incomplete:** stop, report the blocker ("Waiting on G2 (09/10/11/12) and G1 (04/06/08) signoff"), do not write a policy against an unverified `role` source.

## Owner / recommended agent profile

**Backend security architect** — fluent with policy libraries (CASL or `accesscontrol.js`), Express middleware composition, RedBean `tenant_user` queries, and Node.js test runner. Must understand the plan's intent (Super Admin → Tenant Admin → Member → Viewer) and translate it into a permission matrix without inventing new roles beyond those four.

## Exact files and artifacts to create or modify

1. **Create** `server/rbac/roles.js` — exports the four-role enum (`SUPER_ADMIN`, `TENANT_ADMIN`, `MEMBER`, `VIEWER`) as frozen string constants (matching G1's `tenant_user.role` values; the strings are lowercase snake-case — `super_admin`, `tenant_admin`, `member`, `viewer`).
2. **Create** `server/rbac/permissions.js` — exports the permission enum as a flat const object, keys namespaced by domain (`monitor.create`, `monitor.update`, `monitor.delete`, `monitor.read`, `monitor.pause_resume`, `notification.create`, `notification.update`, `notification.delete`, `notification.read`, `status_page.create`, `status_page.update`, `status_page.delete`, `status_page.read`, `tag.manage` (create/edit/delete combined — operators are shared; preserving current single-handler shape), `maintenance.manage`, `incident.manage`, `proxy.manage`, `docker_host.manage`, `api_key.manage`, `monitor_group.manage`, `tenant.user.invite`, `tenant.user.remove`, `tenant.user.role.update`, `tenant.settings.update`, `system.tenant.suspend`, `system.tenant.delete`, `system.view_all_tenants`, `system.audit_log.read`). The list is **additive only** — never rename or drop a key later; downstream tasks depend on string identity.
3. **Create** `server/rbac/policy.js` — exports `ROLES_PERMISSIONS` (mapping each role to its set of permissions) and the isomorphic ability builder: a function `buildAbilityFor(role)` returning a `{ can(permission): boolean, canAny([...]): boolean }` object, backed by **CASL** (preferred, per the plan's "CASL — isomorphic" guidance; reused by G7 in the browser). Defer isomorphic browser packaging to G7 — here we ship the Node-side `buildAbilityFor` only; the contract shape (`can/canAny`) is what G7 will mirror on the client.
4. **Create** `server/middleware/require-rbac.js` — exports:
   - `requireRole(...roles)` — Express middleware that throws `TranslatableError("forbiddenRole")` if `req.user.role` is not in the list (resolves role from `req.user.role`, set by G2 `resolveTenant()`).
   - `requirePermission(permission)` — Express middleware that throws `TranslatableError("forbiddenPermission")` if `buildAbilityFor(req.user.role).can(permission)` is false.
   - `requireSuperAdmin()` — convenience shortcut for `requireRole(ROLES.SUPER_ADMIN)`, used by G9 admin routes later.
5. **Create** `server/rbac/socket-rbac.js` — exports:
   - `checkRole(socket, ...roles)` — throws `TranslatableError("forbiddenRole")` if `socket.role` (set in G2 task-09) is missing or not in the list. **Does not** replace `checkLogin(socket)` — it runs **after** `checkLogin(socket)` so the G2 tenant assertion holds first.
   - `checkPermission(socket, permission)` — throws `TranslatableError("forbiddenPermission")` if `buildAbilityFor(socket.role).can(permission)` is false.
   - `getSocketRole(socket)` — reads `socket.role`; if undefined (legacy pre-G2 session, shouldn't occur post-G2 because `checkLogin` now asserts tenant context), returns `null` to make the failure loud rather than defaulting to `viewer` silently.
6. **Modify** `server/server.js` — **only** to set `socket.role = activeTenantRole` in `afterLogin` (the role value that `auth.listTenantsForUser(userId)` already returns; G2 task-09 left this hook for G3). Do not touch any other handler; 14/15 own the per-handler enforcement sweep.
7. **Modify** `src/lang/en.json` — add keys `forbiddenRole` and `forbiddenPermission` (en only, per repo rule; translations via Weblate).
8. **No other file** — `tenant_user.role` column (G1 task-04) is left as-is (validation of role string value is done in this module, not as a DB constraint — that's G1's existing decision not to revisit). CASL is added as a production dependency via npm (see "Implementation steps").

## Concrete implementation steps

1. Re-read the plan's G3 section and its role-matrix table. Implement exactly those four roles. The plan lists "Permissions chính" per role — translate each "quyền chính" (e.g., "Quản lý monitor" for Tenant Admin) into the granular permission strings in `permissions.js`. **Do not** invent a fifth role or split "Member" into sub-tiers; if a missing capability surfaces, raise an RFC rather than silently adding a role.
2. **`server/rbac/roles.js`:**
   ```js
   const ROLES = Object.freeze({
       SUPER_ADMIN: "super_admin",
       TENANT_ADMIN: "tenant_admin",
       MEMBER: "member",
       VIEWER: "viewer",
   });
   const ROLE_HIERARCHY = Object.freeze([ ROLES.SUPER_ADMIN, ROLES.TENANT_ADMIN, ROLES.MEMBER, ROLES.VIEWER ]);
   module.exports = { ROLES, ROLE_HIERARCHY };
   ```
   - `ROLE_HIERARCHY` is informational — RBAC here is **explicit allow-list** (a Super Admin does not "inherit" Tenant Admin permissions implicitly; the policy explicitly grants Super Admin every permission). This avoids inheritance confusion and keeps the matrix auditable.
3. **`server/rbac/permissions.js`:** export a flat `Object.freeze({...})` of string constants. Each value is the dotted string itself (e.g., `PERMISSIONS.MONITOR_CREATE = "monitor.create"` — the key and value share the SCREAMING to dotted shape so grep against source code finds both the symbol and the literal).
4. **`server/rbac/policy.js`:**
   - For each role, hardcode the set of permission strings. Place the matrix at the top of the file as a plain JSON-like object so the reviewer sees the whole surface in one screen:
     - `VIEWER`: `monitor.read`, `status_page.read`, `notification.read`.
     - `MEMBER`: everything in `VIEWER` plus `monitor.create`, `monitor.update`, `monitor.pause_resume`, `notification.create`, `notification.update`, `notification.delete`, `tag.manage`, `incident.manage`. (Plan: "tạo/sửa monitor được cấp, quản lý notification của mình").
     - `TENANT_ADMIN`: everything in `MEMBER` plus `monitor.delete`, `status_page.create`/`update`/`delete`, `maintenance.manage`, `proxy.manage`, `docker_host.manage`, `api_key.manage`, `monitor_group.manage`, `tenant.user.invite`, `tenant.user.remove`, `tenant.user.role.update`, `tenant.settings.update`.
     - `SUPER_ADMIN`: every permission key in `permissions.js` (the plan: "Quản lý tenant, billing, xem logs/metrics toàn hệ thống" — so all `system.*` and all tenant-admin permissions).
   - Use **CASL** (`@casl/core` + `@casl/ability`) — install via `npm install @casl/core @casl/ability --save` with `--legacy-peer-deps` (project `.npmrc` already sets this).
   - `buildAbilityFor(role)` returns `new Ability([ ...flatRules ])`. Rules are `{ action: permission, subject: "all" }` for each allowed permission. **Do not** use CASL's "subject" feature for resource-level checks (e.g., "monitor owner only") — that level of granularity belongs to G4 repository layer owner-checks, not here. Here, RBAC is role+permission only; resource-level owner-checks are G4's job.
5. **`server/middleware/require-rbac.js`:**
   - `requireRole(...roles)` reads `req.user?.role`; if not in `roles`, calls `next(new TranslatableError("forbiddenRole"))`.
   - `requirePermission(permission)` reads `req.user?.role`, calls `buildAbilityFor(role)`, throws on `!can(permission)`.
   - Both reuse `TranslatableError` (already used by `task-10` `tenantContextRequired`/`tenantAccessDenied`).
6. **`server/rbac/socket-rbac.js`:**
   - `checkRole(socket, ...roles)` after `checkLogin(socket)` ensures tenant context; reads `socket.role`; throws `TranslatableError("forbiddenRole")` on mismatch.
   - `checkPermission(socket, permission)` — same flow via `buildAbilityFor(socket.role)`.
   - Document the contract: every socket mutation handler in 14/15 will follow this pattern:
     ```js
     checkLogin(socket);
     checkPermission(socket, PERMISSIONS.MONITOR_CREATE);
     ```
7. **`server.js` afterLogin wiring:** in the post-G2 `afterLogin(socket, user)` function that already sets `socket.tenantID`, add `socket.role = activeTenantRole` where `activeTenantRole` is the role resolved by `auth.listTenantsForUser(user.id)` for the active `tenantId`. Use the same membership lookup as G2 — do not re-query; fetch the role from the same list `task-09` returns to the client (single source of truth). If G2's `listTenantsForUser` already cached the role on the socket, no change needed — verify with grep before writing.
8. Add JSDoc to every export; `.eslintrc.js` (4-space indent, double quotes, semicolons); run `npx eslint server/rbac/ server/middleware/require-rbac.js server/server.js src/lang/en.json` before signoff.
9. **Do not** add per-call-site enforcement — 14/15 own that sweep.

## Interfaces/contracts and integration points

- **Upstream consumer (within G3):** roles 14 (sockets) and 15 (HTTP) thread `checkRole`/`checkPermission` and `requireRole`/`requirePermission` into existing handlers. They must not change the matrix; if a needed permission is missing, raise a blocker against this task.
- **Downstream consumers (later phases):**
  - G7 (UI) — `buildAbilityFor` is the isomorphic surface; G7 will bundle the same `policy.js` (or a tree-shaken client build of CASL) for the browser to gate menus/buttons. **The contract shape `{ can, canAny }` is frozen here** — G7 must not need a different surface.
  - G9 (Security/Observability) — `requireSuperAdmin()` is the gate for system admin routes (`system.*` permissions). G9 audit logging reads role-action pairs but does not change the matrix.
  - G5 (Monitoring) — quota-enforcement middleware (per plan: "số monitor tối đa") reads `req.user.role` from `tenant.plan` + role context. Quota is orthogonal to RBAC (a `member` hitting a quota is a 429, not a 403) — G5 implements quota; G3 only freezes RBAC.
- **Contract — frozen by this task:**
  - Role strings: `super_admin`, `tenant_admin`, `member`, `viewer` (must match the values stored on `tenant_user.role` from G1 task-04; if the G1 choice differs, raise a blocker — do not silently rename).
  - Permission strings: dotted, lowercase, additive only.
  - `buildAbilityFor(role)` → `{ can(permission): boolean, canAny([...]): boolean }`.
  - Express middleware surface: `requireRole(...roles)`, `requirePermission(permission)`, `requireSuperAdmin()`.
  - Socket helper surface: `checkRole(socket, ...roles)`, `checkPermission(socket, permission)`, `getSocketRole(socket)`.
  - `socket.role` is **always set** after `checkLogin(socket)` succeeds post-G3 — verify 14/15 enforce this invariant.

## Acceptance criteria

- [ ] `server/rbac/roles.js` exports the four-role enum and `ROLE_HIERARCHY` (frozen).
- [ ] `server/rbac/permissions.js` exports the frozen permission const object covering every domain listed in the plan's G3 role matrix (monitor, notification, status_page, tag, maintenance, incident, proxy, docker_host, api_key, monitor_group, tenant.user.*, tenant.settings.update, system.*).
- [ ] `server/rbac/policy.js` exports `ROLES_PERMISSIONS` and `buildAbilityFor(role)` returning `{ can, canAny }` backed by CASL.
- [ ] The role matrix covers all four roles and every `MEMBER` permission ⊆ `TENANT_ADMIN`'s permissions ⊆ `SUPER_ADMIN`'s permissions; `VIEWER` ⊆ `MEMBER`'s.
- [ ] `server/middleware/require-rbac.js` exports `requireRole`, `requirePermission`, `requireSuperAdmin` — all throw `TranslatableError("forbiddenRole" | "forbiddenPermission")` on failure.
- [ ] `server/rbac/socket-rbac.js` exports `checkRole`, `checkPermission`, `getSocketRole` — all throw `TranslatableError` on failure; none of them bypass `checkLogin(socket)` (they run after it).
- [ ] `server.js` `afterLogin` sets `socket.role` alongside `socket.tenantID` (single change site — no other handler modified).
- [ ] `src/lang/en.json` contains `forbiddenRole` and `forbiddenPermission`.
- [ ] `package.json` adds `@casl/core` + `@casl/ability` as production deps with `--legacy-peer-deps` respected.
- [ ] `npm run lint` passes on every new/modified file.
- [ ] No changes outside `server/rbac/`, `server/middleware/require-rbac.js`, `server/server.js` (single hook site), `src/lang/en.json`, `package.json`, `package-lock.json`.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/rbac/ server/middleware/require-rbac.js server/server.js src/lang/en.json

# 2. RBAC exports exist
node -e "
const roles = require('./server/rbac/roles');
const perms = require('./server/rbac/permissions');
const policy = require('./server/rbac/policy');
const mw = require('./server/middleware/require-rbac');
const sock = require('./server/rbac/socket-rbac');
['ROLES','ROLE_HIERARCHY'].forEach(k => console.log((roles[k] ? 'OK' : 'MISSING')+' roles.'+k));
console.log('perms keys:', Object.keys(perms).length, 'expected >= 25');
['buildAbilityFor','ROLES_PERMISSIONS'].forEach(k => console.log((typeof policy[k] === 'function' || policy[k] ? 'OK' : 'MISSING')+' policy.'+k));
['requireRole','requirePermission','requireSuperAdmin'].forEach(k => console.log((typeof mw[k] === 'function' ? 'OK' : 'MISSING')+' mw.'+k));
['checkRole','checkPermission','getSocketRole'].forEach(k => console.log((typeof sock[k] === 'function' ? 'OK' : 'MISSING')+' sock.'+k));
"

# 3. Matrix subset invariants
node -e "
const { ROLES_PERMISSIONS } = require('./server/rbac/policy');
const sup = s => new Set(s);
const viewer = sup(ROLES_PERMISSIONS.viewer);
const member = sup(ROLES_PERMISSIONS.member);
const admin = sup(ROLES_PERMISSIONS.tenant_admin);
const super = sup(ROLES_PERMISSIONS.super_admin);
for (const p of viewer) if (!member.has(p)) throw 'viewer ⊄ member: '+p;
for (const p of member) if (!admin.has(p)) throw 'member ⊄ tenant_admin: '+p;
for (const p of admin) if (!super.has(p)) throw 'tenant_admin ⊄ super_admin: '+p;
console.log('OK: subset invariants hold (viewer ⊆ member ⊆ tenant_admin ⊆ super_admin)');
"

# 4. buildAbilityFor shape
node -e "
const { buildAbilityFor } = require('./server/rbac/policy');
const a = buildAbilityFor('viewer');
console.log('viewer can monitor.read:', a.can('monitor.read'));
console.log('viewer can monitor.create (must be false):', a.can('monitor.create'));
if (a.can('monitor.create')) process.exit(1);
"

# 5. afterLogin wires socket.role
grep -nE 'socket\.role\s*=' server/server.js

# 6. i18n keys
grep -q '"forbiddenRole"\|"forbiddenPermission"' src/lang/en.json

# 7. CASL installed
node -e "require('@casl/core'); require('@casl/ability'); console.log('OK CASL installed')" 2>/dev/null || echo 'MISSING CASL — run npm i with --legacy-peer-deps'

# 8. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/rbac/|server/middleware/require-rbac\.js|server/server\.js|src/lang/en\.json|package\.json|package-lock\.json)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Security lead / Uptime Kuma maintainer — **this is the G3 entry-point signoff**. Specifically confirms:
- (a) the role strings exactly match G1's `tenant_user.role` column values (no silent rename),
- (b) `VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN` holds (no missing inherited permission),
- (c) `socket.role` is set in `afterLogin` such that `checkLogin(socket)` passing is sufficient for `checkRole`/`checkPermission` to have a role to read (no "role is undefined" runtime holes),
- (d) the matrix matches the plan's role-quyền table exactly — no extra privileges granted silently; gaps should be raised as blocker/RFC,
- (e) CASL is used isomorphically-ready (G7 will reuse the same module in the browser) — the surface `{ can, canAny }` is what G7 needs, no browser-specific shape required.

## Explicit out-of-scope

- **Do not** thread `checkPermission`/`requirePermission` into any existing handler — that is task-14 (sockets) and task-15 (HTTP). This task ships the contract only.
- **Do not** add resource-level (owner-based) checks ("only the creator can edit this monitor") — that is G4's repository-layer responsibility; RBAC here is role+permission only.
- **Do not** define a billing/quota matrix (e.g., "Pro plan can edit") — quotas belong to G5/G8; G3 freeses RBAC only.
- **Do not** add the audit-log write call site — that is G9. The matrix here is what G9 will reference (role-action pairs), but no `audit_log` rows are written by this task.
- **Do not** bundle CASL for browser use — G7 owns the client-side ability pack; here we ship Node-side only with the same import path.
- **Do not** introduce a 5th role or split existing ones (e.g., a "billing_manager" role). Any missing capability → raise as RFC, do not silently extend the matrix.
- **Do not** validate role strings against the DB at runtime — G1 task-04 decided role is a free-form string; this task's frozen enum is the canonical set; if a stale role value appears, the policy's `buildAbilityFor` returns an empty ability (deny-by-default) — log a warning via the project's `log` util, do not throw (avoid runtime crashes on legacy data).
- **Do not** change G1's `tenant_user.role` schema (no DB constraint) — that's a G1 decision not revisited by G3.
- **Do not** add quota-check middleware (per plan "số monitor tối đa") — G5.
- **Do not** touch the public status page routing beyond declaring that `status_page.read` does not require authentication (the public viewer is implicit; the RBAC matrix here applies only to authenticated users).

## Coordinator status
- Status: completed
- Completed by: Oracle (CTO)
- Completed at: 2026-08-25T07:20:00Z
- Verification: PR #33 reviewed (roles/permissions/policy/middleware/socket helpers + server.js role wiring); test-rbac.js 27/27 pass, test-tenant-auth.js 18/18 pass (node v22), eslint clean on all changed files. Merged squash 0d3367fe.
- Commit or artifact reference: PR #33 → master 0d3367fe; contract consumed by task-14 (KUM-116) / task-15 (KUM-31) sweeps now in flight.
