# ADR-0003 — Routing and Tenant Resolution

- **ADR:** ADR-0003 — Reverse proxy choice and `resolveTenant()` resolution order
Status: Proposed
Date: 2026-08-23
Deciders: CTO (architecture lead), Backend engineers (Dev1/Dev2), QA

## Context

Multi-tenant status pages must be reachable three ways: **subdomain** (`acme.status.example.com`), **custom domain** (`status.acme.com` pointed at us via CNAME), and **path** (`/status/:slug`, today's only mode). Custom domains imply automatic TLS at zero cost.

What exists today (per the G0.01 survey):

- `server/routers/status-page-router.js` is mounted in `server/server.js:376–377` and serves the SPA shell for `/status/:slug` plus public data endpoints `/api/status-page/:slug/*` — all unauthenticated, visibility gated by data conditions.
- The schema already models custom domains: table `status_page_cname` holds a unique `domain varchar(255)` per status page (`database-schema.md` §status_page_cname), and `/api/entry-page` returns the status-page domain mapping. CNAME validation plumbing partially exists; TLS provisioning does not (upstream delegates to external proxies or Cloudflare tunnels).
- Socket.IO shares the same HTTP server, so tenant context must resolve identically on the socket path.

The plan freezes the tenant-resolution priority: **subdomain → custom domain → `X-Tenant-ID` header → session/JWT claim**, implemented exactly in that order.

## Decision

1. **Reverse proxy: Caddy 2.x** as the reference edge for multi-tenant deployments, with an Nginx config *generator* also shipped by G6 for operators who standardize on Nginx. Caddy is chosen because:
   - **Automatic HTTPS is built in** (Let's Encrypt/ZeroSSL ACME, incl. renewal) — no certbot sidecar, satisfying "SSL tự động qua Let's Encrypt/Caddy" with zero cost;
   - **On-demand TLS** issues certificates lazily per requested hostname — the only practical way to serve arbitrary customer custom domains without pre-registering each one;
   - single static binary, trivially templated — G6's generated-config workflow emits a small Caddyfile from the `status_page_cname` table.
2. **`resolveTenant()` middleware priority (exact order):**
   1. **Subdomain** — parse the host's first label against the configured status-domain base (e.g., `*.status.example.com`);
   2. **Custom domain** — exact match of the full hostname against `status_page_cname.domain`;
   3. **`X-Tenant-ID` header** — honored **only when the request carries a valid authenticated principal whose tenant membership includes that id, or originates from the trusted internal allowlist** (prevents anonymous spoofing);
   4. **Session/JWT claim** — fall back to the active-tenant claim (see ADR-0004).
   First match wins; failure to resolve falls through to the default tenant for logged-in dashboard use, or 404 for public status-page routes.
3. Status-page routes keep their slug dimension: resolution yields `(tenant_id, slug)` pairs (G6's `resolveStatusPageTenant()`), never tenant alone.
4. Node stays the source of truth for authorization; the reverse proxy performs routing/TLS only and forwards `Host`/`X-Forwarded-*` verbatim.

## Consequences

- **TLS automation:** Caddy owns ACME accounts, rate-limits itself against Let's Encrypt; staging environments must point Caddy at the LE staging endpoint to avoid quota burn. On-demand TLS requires an ask endpoint or Caddy's built-in permission module to prevent certificate-harvesting abuse.
- **DNS/CNAME verification flow:** before a custom domain goes live, the app must verify the CNAME actually points at our edge (the existing `status_page_cname` unique-domain constraint becomes the registration anchor); issuance failures surface to the tenant admin with actionable messages.
- **Caching:** public status pages become cache-friendly (`Cache-Control` with short TTLs, G6). Cache keys must include the resolved `(tenant_id, slug)` — never raw headers alone — so tenant resolution must complete before any cache lookup.
- **Socket parity:** the same resolution logic runs at Socket.IO connection time so room partitioning `(tenant_id, user_id)` starts from a verified tenant (G2).
- **Header trust:** because `X-Tenant-ID` sits third in the chain, its guard rails are normative; treating it as trusted input from arbitrary clients would break isolation.

## Alternatives

- **Traefik (not chosen):** excellent dynamic configuration via provider APIs and strong in Kubernetes, but its label/file-provider model fights our generate-static-config-from-database workflow, ACME + on-demand setup is more moving parts, and it brings a heavier runtime footprint than a single Caddy binary for this appliance-style product.
- **Nginx + certbot (fallback, not primary):** ubiquitous and fast, but certificates require an external certbot renewal loop plus reload choreography; no native on-demand issuance, so arbitrary custom domains need pre-provisioned certs or manual steps. Kept as a supported generator target (plan mandates both generators), not the reference edge.
- **Node-level termination only (rejected):** doing ACME inside the Node process couples TLS lifecycle to app deploys/restarts and reimplements what Caddy provides; rejected for operational risk despite removing a process from the stack.
