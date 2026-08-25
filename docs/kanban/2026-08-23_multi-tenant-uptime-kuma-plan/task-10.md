# Task G2.10 — `resolveTenant()` HTTP Middleware + Tenant Guard

**Phase:** G2 — Authentication & Tenant Context
**Status:** todo
**Reviewer:** Backend lead / Uptime Kuma maintainer

## Objective

Introduce the standard HTTP middleware pair that every business-route request passes through:

1. **`resolveTenant()`** — determines the active tenant for an incoming request, following the ADR-0003 priority order: subdomain → custom domain → `X-Tenant-ID` header → session/JWT claim. Sets `req.user.tenantId` and `req.user.role`.
2. **`requireTenantContext()`** — guard that throws `400 Bad Request` if `req.user.tenantId` is not set after `resolveTenant()` ran. Applied to all business routes (`/api/...` business endpoints, not push tokens or public status pages).

Also wire an explicit "switch tenant" endpoint that re-issues a JWT with the next tenant (consumes task-09's claim shape). **No socket.io changes here** (task-11) and **no role-based authorization** (G3).

## Prerequisites/dependencies

- **Task G2.09** reviewed and approved — the JWT claim shape `{ username, h, tid, role }` and `socket.tenantID` are the contracts this task consumes.
- **G1 task-04 / task-06** approved — `tenant`, `tenant_user` tables + default tenant backfill exist; `auth.listTenantsForUser(userId)` is available.
- **G0 ADR-0003** approved — the priority order (subdomain → custom domain → `X-Tenant-ID` → JWT claim) is the spec.
- **If Task G2.09 is incomplete:** stop, report the blocker, do not write middleware against an unverified claim shape.

## Owner / recommended agent profile

**Backend engineer (Express)** — fluent with Express middleware composition, `req`/`res` lifecycle, the project's existing `allowDevAllOrigin` / rate-limiter middleware style (`server/util-server.js`). Must respect the existing `checkLogin(socket)` socket-side path (do not duplicate its responsibility on HTTP — the two stacks authenticate differently).

## Exact files and artifacts to create or modify

1. **Create** `server/middleware/resolve-tenant.js` — exports `resolveTenant()` and `requireTenantContext()`.
2. **Create** `server/middleware/index.js` — re-export the pair for ergonomics.
3. **Modify** `server/server.js` — register `resolveTenant()` globally (after the existing CORS/rate-limiter stack, before business routes), and `requireTenantContext()` on the API router. Touch **only** the mount lines; do not refactor unrelated routes.
4. **Modify** `server/routers/api-router.js` — add a new endpoint `POST /api/switch-tenant` (body: `{ tenantId }`) that re-issues a JWT for the requested tenant (verifies membership via `tenant_user` first). All other existing endpoints gain `requireTenantContext()` via the router-level mount — do not modify individual handlers.
5. **Modify** `server/routers/status-page-router.js` — apply `resolveTenant()` so a public status page request can be resolved by subdomain/custom-domain without authentication. Do NOT apply `requireTenantContext()` here (status pages are public); the tenant context is used by G6 to scope slugs.
6. **No other file** — socket handlers, client.js, model files untouched (those are task-11 / G3 / G4).

## Concrete implementation steps

1. Re-read `docs/adr/ADR-0003-routing-and-tenant-resolution.md`. Its "Decision" section pins the priority order. Implement exactly that order; do not reorder even if a "more secure" alternative is tempting — changing the order requires a new ADR.
2. **`server/middleware/resolve-tenant.js`:**
   - `resolveTenant()` returns `(req, res, next) => { … }` and resolves `tenantId` by trying, in order:
     1. **Subdomain** — `req.hostname` first label (e.g., `acme.status.yourapp.com` → `acme`). Honor `Settings.get("trustProxy")` and `X-Forwarded-Host` (the pattern is already in `api-router.js`'s `/api/entry-page` handler — extract the same hostname-access logic into a small reusable helper so both call sites stay consistent). Map the subdomain label to a `tenant_id` via a lookup on `tenant.slug` (use the `tenant` model from G1 task-04; the `slug` column is unique and indexed per G1 task-04).
     2. **Custom domain** — `req.hostname` directly (e.g., `status.acme.com`); map via `tenant.custom_domain` (indexed in G1 task-04). Subdomain vs custom-domain disambiguation: if the hostname matches an entry in a server-allowed base-domain suffix list (configurable env `UPTIME_KUMA_BASE_DOMAIN`), treat the first label as a subdomain; otherwise look it up as a custom domain. Document this rule in a JSDoc above the function — the rule is reused by G6.
     3. **`X-Tenant-ID` header** — `req.header("X-Tenant-ID")`; treat it as a `tenant.slug` or `tenant.id` (prefer slug, the human form). **Security rule:** a header value only counts if the authenticated user (from JWT) is a member of that tenant; otherwise ignore the header and fall through. Do not just trust the header blindly — that would be a cross-tenant escalation vector.
     4. **JWT claim** — `req.user.tid` (set up ahead by the existing JWT verify middleware). If claim is `undefined` (legacy single-tenant token), resolve to the default tenant (`slug === "default"`).
   - `requireTenantContext()` returns `(req, res, next)` that calls `next(new TranslatableError("tenantContextRequired"))` if `req.user?.tenantId` is missing. Use the project's existing `TranslatableError` (`server/translatable-error.js`) for the message so the i18n key flow is consistent with `authNoTenants` in task-09.
3. **`server/server.js` mount order** (this is the one place you must edit carefully):
   - `app.use(resolveTenant())` — runs **after** the existing rate-limiter/CORS stack but **before** the API router. Place a comment explaining the ordering for reviewers.
   - `app.use("/api", requireTenantContext(), apiRouter)` — wrap the API router with the guard. Existing public routes (`/api/entry-page`, `/api/push/:pushToken`, `/metrics`) must remain exempt: explicitly mount them **before** the guarded mount or under a separate router that doesn't apply the guard. **Push tokens authenticate via the monitor's `push_token`, not via a user JWT** — leave that flow untouched; the monitor is tenant-scoped via its own row's `tenant_id` (G1 task-05), looked up by the push handler.
4. **`api-router.js` `POST /api/switch-tenant`:**
   - Body: `{ tenantId }` (number or slug — accept both, normalize).
   - Authenticate the user via the existing `basicAuth` authorizer (api key path) **or** a new `bearerAuth` JWT path (the API router already mounts `basicAuth` for API keys; add a parallel `bearerAuth` if the project has JWT bearer middleware; if not, document the gap and route through socket.io for the primary switch flow — the endpoint is the HTTP convenience mirror, not the canonical path; the canonical switch path is the socket `loginByToken` re-issue from task-09).
   - Verify membership via `tenant_user`; on success, call `User.createJWT(user, tenantId, role, server.jwtSecret)` and return it; on failure, return 403 with `TranslatableError("tenantAccessDenied")`.
5. **`status-page-router.js`:** apply only `resolveTenant()` (no tenant guard) — public pages still need a tenant context to scope slug lookups. If no tenant resolves (root-domain request that is neither subdomain nor custom domain), fall back to the default tenant so existing status pages on the root domain (the original Uptime Kuma use case) keep working — backward compat.
6. **Settings:** if `UPTIME_KUMA_BASE_DOMAIN` is unset, treat every hostname as a custom-domain lookup (the pre-multi-tenant behavior). Document this fallback.
7. Add i18n keys `tenantContextRequired` and `tenantAccessDenied` to `src/lang/en.json` (en only, per repo rule).
8. JSDoc every function; `.eslintrc.js` 4-space/double-quote/semicolons.

## Interfaces/contracts and integration points

- **Upstream consumer (within G2):** task-09 issues the JWT claim with `tid`; this task reads it as the lowest-priority resolver.
- **Downstream consumers (within G2):**
  - `task-11` (Socket.IO rooms) consumes the **same priority logic** for websocket handshake — task-11 may import a shared `_resolveTenantId(req, { user })` helper exported from this middleware module; expose it as `resolveTenantIdForInbound(inbound, { user })` so both HTTP and socket layers share a single source of truth (no copy-paste).
  - `task-12` (force-logout) consumes the membership check used by `X-Tenant-ID` validation — its tests assert that a revoked membership is rejected here.
- **Downstream consumers (later phases):**
  - G3 (RBAC) reads `req.user.role` set here (the claim's role).
  - G4 (Repository) reads `req.user.tenantId` to inject into every query.
  - G6 (Status Page) resolves the tenant on public routes using the same priority via the shared helper.
- **Contract — public-route exemption:** `requireTenantContext()` is applied **only** to guarded routes; `/metrics`, `/api/entry-page`, `/api/push/:pushToken`, and the public status pages are explicitly on the exempt mount chain.
- **Backward-compat contract:** a request to the root domain with no `X-Tenant-ID` and no JWT claim resolves to the default tenant — the existing single-tenant deployment keeps working.

## Acceptance criteria

- [ ] `server/middleware/resolve-tenant.js` exports `resolveTenant()`, `requireTenantContext()`, and `resolveTenantIdForInbound()` (shared helper).
- [ ] `server/middleware/index.js` re-exports them.
- [ ] The priority order is exactly: subdomain → custom domain → `X-Tenant-ID` (membership-checked) → JWT claim → default tenant.
- [ ] `requireTenantContext()` throws a `TranslatableError("tenantContextRequired")` for missing context.
- [ ] `server.js` mounts `resolveTenant()` globally and `requireTenantContext()` on the API router, with public routes (`/api/entry-page`, `/api/push/:pushToken`, `/metrics`) exempted.
- [ ] `POST /api/switch-tenant` re-issues a JWT after verifying membership; rejects with `TranslatableError("tenantAccessDenied")` on failure.
- [ ] `status-page-router.js` applies only `resolveTenant()`; a root-domain status page request still resolves (to default tenant) without authentication.
- [ ] The `X-Tenant-ID` header is **not trusted blindly** — it is validated against the user's `tenant_user` membership; users cannot read another tenant's data by forging the header.
- [ ] A legacy JWT (pre-G2, no `tid` claim) authenticates and resolves to the default tenant (no regression).
- [ ] `src/lang/en.json` contains `tenantContextRequired` and `tenantAccessDenied`.
- [ ] `npm run lint` passes on every modified file.
- [ ] No changes outside the four files listed (plus `src/lang/en.json`).

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint
npx eslint server/middleware/ server/server.js server/routers/api-router.js server/routers/status-page-router.js src/lang/en.json

# 2. Middleware exports exist
node -e "
const m = require('./server/middleware');
['resolveTenant','requireTenantContext','resolveTenantIdForInbound'].forEach(k => {
  console.log((typeof m[k] === 'function' ? 'OK' : 'MISSING')+' export: '+k);
});
"

# 3. Public routes remain exempt — quick grep should NOT find requireTenantContext mounted before /metrics or /api/push
grep -nE 'app\.use\(\s*[\"'\'']/?(metrics|api/push)' server/server.js
# Manual review: confirm requireTenantContext is mounted on the guarded router only.

# 4. Switch-tenant endpoint exists
grep -nE 'router\.(post|all)\(\s*[\"'\'']\/switch-tenant' server/routers/api-router.js

# 5. Header attack case — descriptive test in task-12 will exercise this; here, just confirm the membership lookup symbol is referenced
grep -nE 'tenant_user' server/middleware/resolve-tenant.js

# 6. Trust-proxy pattern reused
grep -nE 'X-Forwarded-Host|trustProxy' server/middleware/resolve-tenant.js

# 7. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/middleware/|server/server\.js|server/routers/(api|status-page)-router\.js|src/lang/en\.json)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

End-to-end behavior (full integration coverage belongs to `task-12`): a request to `https://acme.example.com/api/...` with a valid user JWT for tenant `acme` must succeed; a request to the same path with the same JWT but a forged `X-Tenant-ID: zeta` header must **not** leak `zeta`'s data (membership check rejects).

## Reviewer

Backend lead / Uptime Kuma maintainer. Specifically confirms:
- (a) the priority order is **exactly** as ADR-0003 specifies (not reordered),
- (b) public routes (push tokens, metrics, public status pages) are **exempt** from the tenant guard — no regression in the existing push/monitor flow,
- (c) the `X-Tenant-ID` header cannot be used to escalate cross-tenant (membership-validated),
- (d) the legacy `tid`-less JWT keeps authenticating (backward compat),
- (e) `resolveTenantIdForInbound` is the single shared resolver consumed by both HTTP and the socket handshake in task-11.

## Explicit out-of-scope

- **Do not** reshape Socket.IO rooms — that is `task-11`.
- **Do not** implement role-based authorization (e.g., `@requireRole`) — G3.
- **Do not** write the Caddy/Traefik reverse-proxy config or Let's Encrypt flow — that is G6/G10.
- **Do not** add the Redis-backed rate-limit-per-tenant — that is G9.
- **Do not** modify the push-token monitor handler beyond ensuring it finds the monitor by `push_token` and uses the monitor's `tenant_id` — task-11 + G5 own the wider push-flow tenancy.
- **Do not** modify the existing `basicAuth` authorizer signature for API keys — that path stays; switch-tenant is the parallel bearer (or socket-only) flow per step 4.
- **Do not** add a separate refresh-token endpoint — the "refresh token" requirement is met by issuing a new access token on switch (per `task-09` step 4).
- **Do not** expose `custom_domain` to clients via any new API here — that's G6's wizard.

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-25T01:45:00Z
- Verification: PR #27 reviewed and squash-merged (ac7da010). Gates at head: eslint clean, tsc exit 0, backend regression suite green; middleware contract covered by test-resolve-tenant-middleware.js (17 cases). resolveTenant/bearerAuth/requireTenantContext wired in server/server.js with exempt-path guard + TranslatableError handler; shared exports (findTenantByIdOrSlug, getMembershipRole, resolveTenantIdForInbound) consumed downstream by task-11 switchTenant.
- Commit or artifact reference: master ac7da010 (PR #27); Paperclip KUM-26
