# Target Architecture Diagram (TO-BE)

> End-to-end view of the multi-tenant runtime, synthesizing [ADR-0001](../adr/ADR-0001-database-choice.md) (database), [ADR-0002](../adr/ADR-0002-isolation-model.md) (isolation), [ADR-0003](../adr/ADR-0003-routing-and-tenant-resolution.md) (routing/tenant resolution), and [ADR-0004](../adr/ADR-0004-authentication-strategy.md) (auth/RBAC). Boxes describe intent; installation/procurement of infrastructure happens in later phases (G6/G10).

## End-to-end flow

```mermaid
flowchart TB
    subgraph Clients["Clients"]
        BR["Browser dashboard<br/>(Vue SPA)"]
        PUB["Public visitors<br/>status pages / badges / RSS"]
        PUSH["Push monitors /<br/>external uptime probes"]
        PROM["Prometheus scraper"]
    end

    subgraph Edge["Edge — reverse proxy (ADR-0003)"]
        CADDY["Caddy 2.x<br/>ACME auto-TLS + on-demand TLS<br/>for custom domains<br/>(Nginx config generator shipped for G6)"]
    end

    subgraph App["Node.js application process"]
        direction TB
        EXPRESS["Express HTTP server<br/>(server/server.js)<br/>api-router + status-page-router"]

        subgraph Resolve["resolveTenant() middleware — exact priority order (ADR-0003)"]
            R1["1. Subdomain<br/>first label vs status-domain base<br/>e.g. acme.status.example.com"]
            R2["2. Custom domain<br/>exact match vs status_page_cname.domain"]
            R3["3. X-Tenant-ID header<br/>ONLY with authenticated membership<br/>or trusted internal allowlist"]
            R4["4. Session/JWT claim tid<br/>hint only - validated against live membership"]
            R1 --> R2 --> R3 --> R4
        end

        GUARD["requireTenantContext() guard (G2)<br/>404 for unresolved public routes,<br/>default tenant for logged-in dashboard"]
        RBAC["RBAC gate (G3, ADR-0004)<br/>CASL buildAbilityFor(role)<br/>super_admin ⊃ tenant_admin ⊃ member ⊃ viewer"]

        REPO["Tenant-safe repository wrapper (G4, ADR-0002)<br/>injects tenant_id into every business query<br/>exemptions documented: user, setting"]

        SIO["Socket.IO server<br/>handshake auth + resolveTenant<br/>rooms keyed (tenant_id : user_id)"]

        subgraph Engine["Monitoring engine (G5)"]
            SCHED["startMonitors()<br/>monitorListByTenant map<br/>per-tenant staggered startup"]
            BEAT["Monitor beat loops<br/>self-scheduling timers per monitor"]
            CALC["UptimeCalculator.listByTenant<br/>stat_minutely / stat_hourly / stat_daily upserts"]
            NOTIF["Notification dispatcher<br/>tenant context carried to providers"]
            JOBS["Background jobs (croner)<br/>clear-old-data: per-tenant retention"]
        end

        METRICS["Prometheus exporter (server/prometheus.js)<br/>every metric labeled tenant_id (G5)"]
    end

    subgraph Data["Data layer (ADR-0001)"]
        MARIADB[("MariaDB<br/>multi-tenant deployments<br/>mysql2 driver via redbean-node/Knex")]
        SQLITE[("SQLite<br/>single-tenant default install<br/>unchanged out-of-box path")]
    end

    REDIS["Redis (OPTIONAL - G10)<br/>cache adapter: keys prefixed tenant:{tenantId}:<br/>Socket.IO adapter for multi-instance rooms"]
    PROVIDERS["107 notification providers<br/>server/notification-providers/*<br/>(email, webhook, Slack, ...)"]
    CADDYCFG["Config generators (G6)<br/>extra/generate-caddy-config.js<br/>extra/generate-nginx-config.js<br/>rendered from status_page_cname table"]

    BR -- "HTTPS dashboard traffic" --> CADDY
    PUB -- "subdomain / custom domain / /status/:slug" --> CADDY
    PUSH -- "POST /api/push/:pushToken" --> CADDY
    PROM -- "GET /metrics" --> CADDY

    CADDY -- "TLS terminated,<br/>Host/X-Forwarded-* forwarded verbatim" --> EXPRESS
    CADDY -.-> CADDYCFG

    EXPRESS --> Resolve
    Resolve --> GUARD
    GUARD --> RBAC
    RBAC --> REPO
    REPO --> MARIADB
    REPO -.-> "single-tenant installs" SQLITE

    BR == "socket.io (same origin)" ==> SIO
    SIO --> GUARD
    SIO --> REPO

    SCHED --> BEAT
    BEAT --> CALC
    BEAT --> REPO
    BEAT -- "io.to(tenantId:userRoom).emit('heartbeat')" --> SIO
    PUSH -- "push ingestion writes heartbeat via repo" --> BEAT
    BEAT --> NOTIF
    NOTIF --> PROVIDERS
    JOBS --> REPO
    CALC --> REPO

    METRICS --> PROM
    BEAT -.-> METRICS
    REPO -.-> REDIS
    SIO -.-> REDIS

    classDef optional stroke-dasharray: 5 5;
    class REDIS optional;
```

## Request-path walkthroughs

### 1. Authenticated dashboard request (REST)

1. Browser calls `https://app.example.com/api/...` through Caddy (TLS).
2. `resolveTenant()` runs the priority chain: no status-domain subdomain match → no `status_page_cname` hit → no `X-Tenant-ID` header from browsers (untrusted) → **JWT claim `tid`**.
3. `requireTenantContext()` attaches `{ tenantId, userId, role }` to the request; missing/invalid membership → auth error, not silent default.
4. RBAC middleware checks the action against `buildAbilityFor(role)` ([ADR-0004](../adr/ADR-0004-authentication-strategy.md)).
5. Repository wrapper executes the query **always filtered by `tenant_id`** ([ADR-0002](../adr/ADR-0002-isolation-model.md)); result returned.

### 2. Public status page (no authentication)

1. Visitor opens `acme.status.example.com` (subdomain) or `status.acme.com` (custom domain, cert issued by Caddy on-demand TLS).
2. `resolveTenant()` matches at step 1 or 2; resolution yields the pair `(tenant_id, slug)` — never tenant alone (G6's `resolveStatusPageTenant()`).
3. Status-page data queries run scoped to both dimensions; visibility still gated by data conditions (`group.public`, published flag) exactly as today.
4. Responses carry short-TTL CDN-friendly `Cache-Control`; cache keys include `(tenant_id, slug)` — never raw headers alone ([ADR-0003 Consequences](../adr/ADR-0003-routing-and-tenant-resolution.md)).

### 3. Push monitor ingestion (unauthenticated write)

1. External probe POSTs `/api/push/:pushToken`.
2. Route resolves the monitor by unique `push_token` (now a tenant-scoped row); the monitor's `tenant_id` is authoritative — push tokens are not authenticated by headers ([plan G3 constraints](../kanban/2026-08-23_multi-tenant-uptime-kuma-plan/README.md#phase-g3--rbac-role-based-access-control)).
3. Heartbeat written through the same repository wrapper; live emit targets room `tenantId:user` instead of bare `user_id`.

### 4. Socket.IO session

1. Handshake authenticates JWT (access token) and runs the same `resolveTenant()` logic so socket context equals HTTP context ([ADR-0003 Socket parity](../adr/ADR-0003-routing-and-tenant-resolution.md)).
2. Client joins rooms keyed `(tenant_id, user_id)`; all server→client emits (`heartbeat`, stats, lists) target tenant-partitioned rooms (G2).
3. Tenant switch = new token pair + rejoin rooms; removal-from-tenant while online forces logout at next validation or refresh ([ADR-0004](../adr/ADR-0004-authentication-strategy.md)).

### 5. Monitoring engine loop (background)

1. On boot, `startMonitors()` loads active monitors **partitioned by tenant** into `monitorListByTenant` with staggered per-tenant startup batches (G5 noisy-neighbor mitigation).
2. Each monitor's self-scheduling `beat()` timer runs its type check, writes the heartbeat row via the tenant-safe wrapper (row anchored by `monitor_id`; tenancy derived — no redundant column), updates `UptimeCalculator` aggregates for that monitor, emits to the owning tenant/user room, and dispatches notifications with tenant context on status transitions.
3. Quota gates (`max monitors`, min check interval) are enforced at `startMonitor()` (G5; database-driven quotas arrive with G8).
4. Nightly retention job deletes expired beats/stats **per tenant retention policy** (hardcoded defaults until G8).

## Enforcement layers (defense in depth)

| Layer | Phase | Mechanism | Blocks |
| --- | --- | --- | --- |
| HTTP/socket tenant context | G2 | `resolveTenant()` + `requireTenantContext()`, socket handshake wiring | Requests without a valid tenant context |
| Role gate | G3 | CASL policy on every business endpoint; self-service exemptions documented in [ADR-0004](../adr/ADR-0004-authentication-strategy.md) | Wrong-role actions |
| Query filter | G4 | Tenant-safe repository wrapper injecting `tenant_id`; ESLint rule `require-tenant-scope` flags bypasses | Cross-tenant reads/writes (IDOR) |
| Engine isolation | G5 | Partitioned scheduler maps; per-tenant emits and retention | Cross-tenant event leakage, noisy neighbors |

## Deliberate non-goals of this diagram

- Redis boxes are **optional future adapters** (G10); nothing in G0–G5 requires them. The cache-key namespace `tenant:${tenantId}:${key}` is frozen early (G4) so procurement stays mechanical.
- Prometheus metrics exist today as `/metrics`; the `tenant_id` label is a G5 change shown here as intent.
- SSL issuance is owned by Caddy outside Node; Node remains source of truth for authorization only ([ADR-0003](../adr/ADR-0003-routing-and-tenant-resolution.md)).
