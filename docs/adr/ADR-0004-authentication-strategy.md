# ADR-0004 — Authentication Strategy and RBAC Model

- **ADR:** ADR-0004 — Authentication strategy and RBAC model
Status: Proposed
Date: 2026-08-23
Deciders: CTO (architecture lead), Backend engineers (Dev1/Dev2), QA

## Context

Authentication today (per `api-and-socket-events.md` and the schema survey):

- Login is username/password over Socket.IO (`login` at `server/server.js:450`, `loginByToken` at :401) with bcrypt hashes (`server/auth.js`) and optional TOTP 2FA (`user.twofa_secret/twofa_status/twofa_last_token` columns).
- Identity on sockets is a single value: `afterLogin()` sets `socket.userID = user.id`; handlers scope queries by that. There are no roles — every user is effectively an instance admin.
- JWT libraries are already dependencies (`jsonwebtoken ~9.0.3`, `jwt-decode` in `package.json`); API-key infrastructure exists but its middleware is currently unused.
- Public routes (`/api/push/:pushToken`, `/api/badge/*`, `/status*`, `/metrics`) are intentionally unauthenticated.

Multi-tenancy adds requirements the plan fixes: a user may belong to multiple tenants with different roles per tenant; the token payload carries `user_id`, `tenant_id`, `role`, `permissions`; tenant switching must rotate tokens; a user removed from a tenant while online must be forced out of it.

## Decision

**Tokens.** Keep JWT-based auth, split into:

- a short-lived **access token** (~15 min) delivered in an httpOnly, SameSite=Lax cookie (plus `Authorization: Bearer` support for API clients), carrying claims `{ sub: user_id, tid: active_tenant_id, role, jti, exp }`;
- a long-lived **rotating refresh token** persisted server-side as a hash in a new `refresh_token` table (family id + jti lineage). Refresh rotation invalidates the used token; reuse of a rotated token kills the whole family (theft detection).

The plan's ambiguity about where `tenant_id` lives is resolved explicitly: **`resolveTenant()` (ADR-0003) is authoritative for tenant context on every request.** The `tid` claim is only a hint/default — validated against live membership each time it is used, never trusted to grant access by itself.

**Tenant switch flow.** `switchTenant` re-checks membership server-side, then issues a fresh access+refresh pair with the new `tid`/`role` claims; the old refresh family is revoked atomically.

**Removal-while-online.** On membership revocation, a hook invalidates refresh families whose active tenant is the removed one and flags the access-token `jti`s; the next request/refresh fails membership validation → client is logged out of that tenant (G2's documented edge case). Hot paths do not hit the DB for this; they trust short access-token TTLs plus the revocation check on refresh.

**RBAC model.** Exactly four roles, frozen by the plan, stored as `tenant_user.role` so the same user can hold different roles in different tenants:

```
super_admin ⊃ tenant_admin ⊃ member ⊃ viewer
(invariant: VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN)
```

- Authorization uses a **CASL isomorphic policy** — `buildAbilityFor(role)` produces `{ can, canAny }` consumed by both backend middleware (G3: HTTP + socket enforcement sweeps) and the frontend (G7) from one module.
- Role gates live at HTTP/socket layers (G3); resource-level owner checks stay in the repository layer (G4). The two dimensions compose: role says *what kind of action*, ownership/tenancy says *which rows*.
- Self-service exemptions available to all roles: `changePassword`, 2FA management, `switchTenant`, login/logout/setup, public status pages, push tokens, badges, `/metrics`.
- No fifth role and no silent capability extension; changes require an RFC. Quota limits ("số monitor tối đa") are deliberately NOT part of RBAC — G5/G8 own them.

## Consequences

- **Token storage:** httpOnly cookies mitigate XSS token theft; CSRF protection becomes mandatory for cookie-borne mutations (same-site lax + CSRF token on state-changing routes).
- **New persistence:** `refresh_token` table (hash, family, expiry) — a small migration in G2; revocation lists are DB-backed, not in-memory, so restarts preserve forced logouts.
- **Clock/TTL discipline:** 15-minute access tokens mean up to 15 minutes of residual access after revocation until the next refresh or socket reconnect; socket rooms are rebuilt with `(tenant_id, user_id)` keys so stale-room leakage dies at reconnect (G2/G5).
- **Every endpoint gains two checks:** tenant-context guard (G2) then role gate (G3). Test suites must cover cross-role and cross-tenant matrices (G3 task-16).
- **Backward compatibility:** the default-tenant admin keeps working unchanged — single-user installs see one tenant, role `tenant_admin`, identical UX; existing public routes remain auth-free per ADR-0003.
- **JWT secret management:** instance-generated signing secret stored like other settings; key rotation supported via `kid` header when introduced.

## Alternatives

- **Pure stateless JWT, no refresh table (rejected):** cannot revoke — "removed from tenant while online" would be unenforceable until natural token expiry, and stolen tokens would live out their full TTL. The revocation requirement forces server-side state somewhere; we put it only in refresh-token lineage and keep hot-path verification stateless.
- **Server-side sessions only (express-session) (rejected):** every request/Socket.IO handshake needs a session-store lookup (Redis or DB) on hot paths, horizontal scaling then requires shared store infrastructure, and the existing `loginByToken`/API-key flows would need rework anyway. Rotating-refresh-JWT achieves the same revocability with cheaper verification.
- **Roles on the user record (single global role) (rejected):** contradicts "a user belongs to multiple tenants with different roles"; per-tenant `tenant_user.role` is the only shape that models it.
- **Fine-grained per-permission claims in the token (rejected):** embedding `permissions[]` bloats every token and freezes permissions at issue time; deriving abilities from `role` at request time via CASL keeps tokens small and permission changes immediately effective.
