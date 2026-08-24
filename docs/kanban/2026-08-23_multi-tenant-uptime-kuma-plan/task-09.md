# Task G2.09 — JWT Claims + Tenant Picker on Login

**Phase:** G2 — Authentication & Tenant Context
**Status:** todo
**Reviewer:** Auth lead / Uptime Kuma maintainer

## Objective

Refactor the user JWT and post-login flow so that an authenticated user receives their list of accessible tenants and picks the active tenant for the session. The JWT payload gains `tenant_id` + `role` claims; the existing `User.createJWT` signature is extended; the login/`loginByToken` socket handlers return the tenant list to the client. **No `resolveTenant()` middleware, no socket room reshaping** here — those are tasks 10 and 11.

This task is the contract originator for the rest of G2: every later task reads the claim shape defined here.

## Prerequisites/dependencies

- **Phase G1 fully approved:** `task-04` (tenant/tenant_user/tenant_invitation tables), `task-06` (default-tenant seeding creates `tenant_user` rows), and `task-08` (the `tenant_user.listForUser(userId)` model helper from `task-04` and the per-model `listForTenant(tenantId)` helpers from `task-08`) all must be reviewed and approved.
- **G0 ADRs:** `docs/adr/ADR-0003-routing-and-tenant-resolution.md` and `docs/adr/ADR-0004-authentication-strategy.md` approved — the JWT claims and token-vs-session decisions live there.
- **If any prerequisite is incomplete:** stop, report the blocker ("Waiting on G1.04/06/08 and ADR-0003/0004 signoff"), do not guess claim shape.

> **CTO ruling (2026-08-25, phase-G2 scope):** ADR-0004's target design (claims `{ sub, tid, role, jti, exp }`, ~15-min expiry, rotating refresh-token table) is **superseded for this phase** by the contract frozen in step 2 below: claims `{ username, h, tid, role }` issued via an extended `User.createJWT(user, tenantId, role, jwtSecret)`, existing `server.jwtSecret`, no refresh-token table, no expiry change. Rationale: zero-cost constraint and incremental migration; current session mechanics are kept and tenancy claims are added additively. Later phases may extend claims **additively only** (incl. `jti`/`exp` hardening) — never rename or remove existing fields. This divergence is recorded in `docs/adr/README.md`; note it in the PR description as well.

## Owner / recommended agent profile

**Auth engineer (backend)** — strong working knowledge of `jsonwebtoken`, Uptime Kuma's auth flow (`server/auth.js`, `server/server.js` `socket.on("login")`/`socket.on("loginByToken")`), and RedBean queries. Must not break the existing 2FA flow.

## Exact files and artifacts to create or modify

1. **Modify** `server/model/user.js` — extend `User.createJWT` to accept `(user, tenantId, role, jwtSecret)` and include `tenant_id` + `role` claims alongside the existing `username`/`h` (shake256) claim. Keep backward shape: existing code paths that pre-date tenancy pass no tenant — handler still works on default tenant.
2. **Modify** `server/auth.js` — add `exports.listTenantsForUser(userId)` returning `[{ id, slug, name, plan, role, is_default }]` via a `tenant_user` join (delegate to the helper from G1 task-04/08 — do not re-implement the query).
3. **Modify** `server/server.js` — touch exactly these handlers:
   - `socket.on("login", ...)` (line ~450): after a successful login (including 2FA path), in addition to `token` return `tenants` (the list) and `activeTenantId` (default to the user's first tenant, or the one in the existing token if `loginByToken`).
   - `socket.on("loginByToken", ...)` (line ~401): read `decoded.tenant_id`; if the user still belongs to that tenant (verified via `tenant_user` query), keep it as `activeTenantId`; if not, fall back to the user's first accessible tenant and re-issue a refreshed JWT with the new claim (so the client stores a valid token). If the user has zero tenants (edge case: removed from all), return `{ ok: false, msg: "authNoTenants", msgi18n: true }`.
   - The `socket.on("setup", ...)` handler (line ~705): after creating the initial admin, also create the default tenant + a `tenant_user` row with role `tenant_admin` (call the G1 task-06 seeding path or the underlying `seedDefaultTenantIfEmpty` helper from `setup-database.js`); do **not** re-implement the seed.
4. **No other file** — routers, middleware, other socket handlers, frontend untouched.

## Concrete implementation steps

1. Re-read `docs/adr/ADR-0004-authentication-strategy.md`. Its "Decision" section states whether `tenant_id` lives in the JWT claim at issue time (this is the claim that ADR-0003's middleware will treat as the lowest-priority resolver). Implement that exact shape — **as refined by the CTO ruling in Prerequisites above: the step-2 contract (`{ username, h, tid, role }`) is authoritative for G2**, not ADR-0004's refresh-token design.
2. **`User.createJWT(user, tenantId, role, jwtSecret)`:**
   ```js
   return jwt.sign({
       username: user.username,
       h: shake256(user.password, SHAKE256_LENGTH),
       tid: tenantId,        // tenant_id claim (short key, smaller token)
       role: role || "viewer",
   }, jwtSecret);
   ```
   - All four claims are mandatory. The `tid`/`role` abbreviations keep token size small and avoid name collisions.
   - Keep backward compatibility on the verify side: reading `decoded.tid` that is `undefined` (an old token from before this task) must be tolerated by falling back to the default tenant via the G2.10 resolver.
3. **`auth.js` `listTenantsForUser(userId)`:**
   - Delegate to `require("../model/tenant_user").listForUser(userId)` from G1 task-04 if that helper returns the joined row; if it returns only tenant ids, extend it once here to fetch display fields (`slug`, `name`, `plan`, role).
   - Mark the row whose `slug === "default"` with `is_default: true` so the client can highlight it.
   - Mask `custom_domain` from this payload — it is routing config, not user-facing; G6 will surface the relevant subset.
4. **`server.js` login/`loginByToken`/`setup` changes:**
   - For `socket.on("login", ...)`: after `await afterLogin(socket, user)`, call the `listTenantsForUser` helper to build `tenants`; pick `activeTenantId = tenants[0]?.id`; issue the JWT with `tenantId=activeTenantId, role=tenants[0].role`; return `{ ok: true, token, tenants, activeTenantId }` to the callback. The 2FA path mirrors this after token verification.
   - For `socket.on("loginByToken", ...)`: verify the token; if `decoded.tid` is present, look up the `tenant_user` row for `(userId, decoded.tid)`. If it exists, keep `activeTenantId = decoded.tid`. If it doesn't (user was removed from that tenant), pick the user's first accessible tenant and re-issue a refreshed JWT with the new claim (so the client stores a valid token). If the user has zero tenants, return `{ ok: false, msg: "authNoTenants", msgi18n: true }`.
   - For `socket.on("setup", ...)`: after creating the admin user, ensure the default tenant exists (call the G1 helper) and add a `tenant_user` row `role="tenant_admin"` for the user; issue the JWT with the default tenant's id.
5. **`afterLogin(socket, user)`** in `server.js` remains the bootstrap that joins the Socket.IO room — but the room key reshape to `tenant:${tid}:user:${uid}` is **task-11**, not this task. Here, just set `socket.tenantID = activeTenantId` (a new property); task-11 will consume it. Do not yet change `socket.join(user.id)`.
6. Add i18n key `authNoTenants` to `src/lang/en.json` **only** (per the `copilot-instructions.md` rule: add keys to `en.json` only; translations happen via Weblate). Use `$t("authNoTenants")` clientside (the actual UI for the picker is G7, but the key must exist now so the message can render).
7. Add JSDoc to every new/modified function; follow `.eslintrc.js` (4-space indent, double quotes, semicolons).

## Interfaces/contracts and integration points

- **Downstream consumer (within G2):**
  - `task-10` (`resolveTenant` middleware) reads `req.user.tenantId` set from the JWT claim **as the lowest-priority resolver** (per ADR-0003). The middleware also consumes the `X-Tenant-ID` header that the client sends after a tenant switch — but the **switch flow itself** is the client calling `loginByToken` again with a refreshed token (per step 4's re-issue logic).
  - `task-11` (Socket.IO rooms) reads `socket.tenantID` set in `afterLogin`.
  - `task-12` (force-logout) consumes `disconnectAllSocketClients` plus a per-tenant variant to be added there.
- **Downstream consumer (later phases):**
  - G3 RBAC reads `req.user.role` / `socket.role` set here; the role value is a placeholder string from G1's `tenant_user.role` column.
  - G7 UI consumes the `tenants` payload from the login callback to render the switcher.
- **Backward-compat contract:**
  - A token issued before G2 (no `tid` claim) must still authenticate — the verify path must treat undefined `tid` as "resolve default tenant via G2.10 middleware".
  - A user with only the default tenant (the single-tenant case) must see a `tenants` array with exactly one element and never be asked to pick a tenant (no extra UX step).
- **Token claim contract (frozen by this task):** `{ username, h, tid, role }`. Subsequent phases may extend by **additive** fields only; never change or remove existing fields.

## Acceptance criteria

- [ ] `User.createJWT(user, tenantId, role, jwtSecret)` exists with the documented signature and issues a token carrying `tid` and `role` claims.
- [ ] `auth.js` exports `listTenantsForUser(userId)` returning the tenant list shape `{ id, slug, name, plan, role, is_default }` and does not include `custom_domain`.
- [ ] `socket.on("login", ...)` callback returns `{ ok, token, tenants, activeTenantId }`.
- [ ] `socket.on("loginByToken", ...)` honors `decoded.tid`; if the user no longer belongs to that tenant, re-issues a JWT with the user's first accessible tenant and returns it; if the user has zero tenants, returns `{ ok: false, msg: "authNoTenants" }`.
- [ ] `socket.on("setup", ...)` creates the default tenant + a `tenant_user(role="tenant_admin")` row for the new admin.
- [ ] Existing 2FA flow (`prepare2FA`/`save2FA`/`disable2FA`/`twoFAStatus`) is unchanged in observable behavior except where the login callback shape extends.
- [ ] `socket.tenantID` is set during `afterLogin` (consumed by task-11).
- [ ] `src/lang/en.json` contains the `authNoTenants` key.
- [ ] `npm run lint` passes on every modified file.
- [ ] No changes outside `server/model/user.js`, `server/auth.js`, `server/server.js`, `src/lang/en.json`.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/model/user.js server/auth.js server/server.js src/lang/en.json

# 2. JSON validity (project has a lang checker)
node extra/check-lang-json.js 2>/dev/null || echo "WARN: lang checker not runnable inline; verify manually"

# 3. JWT claim shape — decode a token issued by the new path
node -e "
const jwt = require('jsonwebtoken');
const UptimeKumaServer = require('./server/uptime-kuma-server');
const User = require('./server/model/user');
(async () => {
  const fakeUser = { id: 1, username: 'admin', password: 'hash' };
  const secret = 'test-secret';
  const token = User.createJWT(fakeUser, 42, 'tenant_admin', secret);
  const decoded = jwt.verify(token, secret);
  console.log('OK tid=' + decoded.tid + ' role=' + decoded.role);
  if (decoded.tid !== 42 || decoded.role !== 'tenant_admin') process.exit(1);
})();
"

# 4. listTenantsForUser returns array shape (uses G1 task-06 default-tenant backfill on a populated DB)
#    This is a smoke test — full integration coverage belongs to task-12.
node -e "
const auth = require('./server/auth');
// Requires the test DB seeded by test/mock-testdb.js
// Run only when G1 migrations are present. Document the expected output.
console.log(typeof auth.listTenantsForUser);  // 'function'
"

# 5. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/model/user\.js|server/auth\.js|server/server\.js|src/lang/en\.json)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Auth lead / Uptime Kuma maintainer. Specifically confirms:
- (a) the **claim shape** is `{ username, h, tid, role }` and frozen for downstream tasks,
- (b) backward compatibility: old tokens (no `tid`) still authenticate,
- (c) the `loginByToken` tenant-still-valid check happens server-side (no client trust),
- (d) the no-tenant edge case returns a sane i18n message,
- (e) the `setup` flow creates the tenant root for the admin so a brand-new install is multi-tenant ready.

## Explicit out-of-scope

- **Do not** write the `resolveTenant()` HTTP middleware or `requireTenantContext()` guard — that is `task-10`.
- **Do not** reshape Socket.IO rooms to the tenant partition or touch `io.to(...)` calls — that is `task-11`.
- **Do not** implement the force-logout-on-tenant-removal job — that is `task-12`.
- **Do not** add RBAC enforcement (role-based endpoint gates) — that is G3.
- **Do not** build the tenant switcher UI in Vue — that is G7. Return the data only.
- **Do not** switch to refresh tokens as a separate mechanism — the plan's "Refresh token when switch tenant" is satisfied by re-issuing an access token on `loginByToken` per step 4; no separate refresh-token table needed in this phase.
- **Do not** introduce a new JWT secret rotation scheme — the existing `server.jwtSecret` stays.
- **Do not** modify the 2FA secret rotation flow (just verify it doesn't break).
