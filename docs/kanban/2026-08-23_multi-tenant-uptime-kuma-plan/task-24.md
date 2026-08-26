# Task G6.24 — Status Page Tenant Resolution + Domain Mapping Refactor

**Phase:** G6 — Status Page Multi-Tenant
**Status:** todo
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Backend lead / Uptime Kuma maintainer (G6 entry-point signoff)

## Objective

Refactor the status page's public routing layer so that every incoming request to a status page can resolve the correct tenant. Currently `StatusPage.loadDomainMappingList()` builds a flat `{ "domain.com": "slug" }` map and `handleStatusPageResponse()` resolves a status page purely by slug — neither is tenant-aware. This task freezes the **tenant-resolution contract** for G6: a subdomain, custom domain, or path-based route must resolve to `(tenantId, slug)` before any data query runs.

This task is the **contract originator** for G6 — downstream tasks 25 (data layer) and 26 (custom domain wizard + tests) consume the frozen resolution API.

## Prerequisites/dependencies

- **Phase G5 fully approved** (tasks 21/22/23):
  - `task-21` — `monitorListByTenant`, `startMonitor(tenantId, ...)`, `startMonitors()` tenant-iterating.
  - `task-22` — heartbeat write path emits to `userRoom(tenantId, userID)`, notification dispatch carries `tenantId`.
  - `task-23` — quota gate, Prometheus `tenant_id` label, engine test suite passing.
- **Phase G4 fully approved** (tasks 17/18/19/20):
  - `task-17` — `findOneForTenant`, `findForTenant`, `execForTenant`, `dispenseForTenant`, `tenantCacheKey` available.
  - `task-20` — IDOR test suite passing; cache-key namespace adopted.
- **Phase G2 fully approved** (tasks 09/10/11/12):
  - `task-10` — `resolveTenant()` HTTP middleware chain (subdomain → custom domain → `X-Tenant-ID` header → session/JWT).
  - `task-11` — `userRoom(tenantId, userID)` socket room key.
- **Phase G1 fully approved** (tasks 04/05/06/08):
  - `task-04` — `tenant` table with `slug`, `custom_domain`, `status` columns.
  - `task-05` — `tenant_id` column on `status_page`, `status_page_cname`, `group`, `incident`, `monitor_group`, `maintenance_status_page`.
  - `task-06` — default tenant + backfill of existing rows.
- **If any G5/G4/G2/G1 task is incomplete:** stop, report the blocker, do not write a resolution layer against unverified contracts.

## Owner / recommended agent profile

**Backend routing engineer** — fluent with Express middleware, `redbean-node`, the existing `StatusPage.loadDomainMappingList()` / `handleStatusPageResponse()` / `handleStatusPageRSSResponse()` flow, and the G2 `resolveTenant()` middleware chain (`server/middleware/tenant.js`). Must understand the existing `entryPage` / `StatusPage.domainMappingList` bootstrap in `server/server.js` lines 251-285.

## Exact files and artifacts to create or modify

1. **Create** `server/middleware/status-page-tenant.js` — exports `resolveStatusPageTenant(req, res, next)` middleware that resolves `(tenantId, slug)` from the request and attaches them to `req.statusPageTenant`.
2. **Modify** `server/model/status_page.js` — `loadDomainMappingList()` → tenant-aware; `handleStatusPageResponse()` → accepts `tenantId`; `handleStatusPageRSSResponse()` → accepts `tenantId`.
3. **Modify** `server/routers/status-page-router.js` — apply `resolveStatusPageTenant` middleware; pass `tenantId` to all handler calls.
4. **Modify** `server/server.js` — entry-page routing honors tenant from hostname; `loadDomainMappingList()` call updated.
5. **Create** `docs/architecture/status-page-routing.md` — documents the resolution priority and how subdomain/path/custom-domain map to tenant.

## Concrete implementation steps

1. **Re-read** `task-10.md` (G2 `resolveTenant()` middleware), `task-11.md` (socket rooms), `task-17.md` (tenant-safe wrapper), and the existing `server/server.js` lines 245-290 (entry page + domain mapping bootstrap).

2. **`server/middleware/status-page-tenant.js`** — the resolution middleware:
   ```js
   const { R } = require("redbean-node");
   const { log } = require("../../src/util");

   /**
    * Resolution priority (per ADR-0003):
    * 1. Custom domain: lookup status_page_cname for the hostname → (tenantId, slug)
    * 2. Subdomain: extract tenant slug from hostname (e.g., acme.status.example.com → acme)
    * 3. Path: extract tenant slug from first path segment (e.g., /acme/status → acme)
    * 4. Session/JWT: fall back to req.user.tenantId (authenticated users only)
    * 5. Default: the "default" tenant's "default" status page
    */
   async function resolveStatusPageTenant(req, res, next) {
       const hostname = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0].toLowerCase();
       const settings = req.app.get("settings") || {};

       // 1. Custom domain lookup
       const cname = await R.findOne("status_page_cname", " domain = ? ", [hostname]);
       if (cname) {
           const statusPage = await R.findOne("status_page", " id = ? AND published = 1 ", [cname.status_page_id]);
           if (statusPage) {
               req.statusPageTenant = { tenantId: statusPage.tenant_id, slug: statusPage.slug };
               return next();
           }
       }

       // 2. Subdomain: extract tenant slug
       const subdomainMatch = hostname.match(/^([a-z0-9-]+)\.status\./);
       if (subdomainMatch) {
           const tenant = await R.findOne("tenant", " slug = ? AND status = 'active' ", [subdomainMatch[1]]);
           if (tenant) {
               const slug = req.params.slug || "default";
               const statusPage = await R.findOne("status_page", " tenant_id = ? AND slug = ? AND published = 1 ", [tenant.id, slug]);
               if (statusPage) {
                   req.statusPageTenant = { tenantId: tenant.id, slug: statusPage.slug };
                   return next();
               }
           }
       }

       // 3. Path-based: /<tenant-slug>/status/...
       const pathMatch = req.path.match(/^\/([a-z0-9-]+)\/status/);
       if (pathMatch) {
           const tenant = await R.findOne("tenant", " slug = ? AND status = 'active' ", [pathMatch[1]]);
           if (tenant) {
               const slug = req.params.slug || "default";
               const statusPage = await R.findOne("status_page", " tenant_id = ? AND slug = ? AND published = 1 ", [tenant.id, slug]);
               if (statusPage) {
                   req.statusPageTenant = { tenantId: tenant.id, slug: statusPage.slug };
                   return next();
               }
           }
       }

       // 4. Session/JWT fallback
       if (req.user && req.user.tenantId) {
           const slug = req.params.slug || "default";
           const statusPage = await R.findOne("status_page", " tenant_id = ? AND slug = ? AND published = 1 ", [req.user.tenantId, slug]);
           if (statusPage) {
               req.statusPageTenant = { tenantId: req.user.tenantId, slug: statusPage.slug };
               return next();
           }
       }

       // 5. Default tenant fallback
       const defaultTenant = await R.findOne("tenant", " slug = 'default' ");
       if (defaultTenant) {
           const slug = req.params.slug || "default";
           const statusPage = await R.findOne("status_page", " tenant_id = ? AND slug = ? AND published = 1 ", [defaultTenant.id, slug]);
           if (statusPage) {
               req.statusPageTenant = { tenantId: defaultTenant.id, slug: statusPage.slug };
               return next();
           }
       }

       // All resolution strategies failed
       return res.status(404).json({ message: "Status page not found" });
   }

   module.exports = { resolveStatusPageTenant };
   ```

3. **`server/model/status_page.js` — `loadDomainMappingList()` refactor:**
   The existing method builds `StatusPage.domainMappingList = { "domain.com": "slug" }` from `status_page_cname`. The refactored version builds `StatusPage.domainMappingList = { "domain.com": { tenantId, slug } }`:
   ```js
   static async loadDomainMappingList() {
       StatusPage.domainMappingList = {};
       const rows = await R.exec(
           "SELECT spc.domain, spc.status_page_id, sp.slug, sp.tenant_id " +
           "FROM status_page_cname spc " +
           "JOIN status_page sp ON sp.id = spc.status_page_id " +
           "WHERE sp.published = 1"
       );
       for (const row of rows) {
           StatusPage.domainMappingList[row.domain] = {
               tenantId: row.tenant_id,
               slug: row.slug
           };
       }
   }
   ```

4. **`server/model/status_page.js` — `handleStatusPageResponse()` signature change:**
   The existing signature is `handleStatusPageResponse(response, indexHTML, slug)`. The new signature is `handleStatusPageResponse(response, indexHTML, slug, tenantId)`:
   - The `R.findOne("status_page", " slug = ? ", [slug])` query adds `AND tenant_id = ?`.
   - After the findOne, if `statusPage.tenant_id !== tenantId` → 404.
   - The `renderHTML()` call passes `tenantId` so it can inject tenant-specific branding (logo, title, OG tags — task 25 makes these actually tenant-aware; task 24 only passes the parameter).

5. **`server/model/status_page.js` — `handleStatusPageRSSResponse()` signature change:**
   The existing signature is `handleStatusPageRSSResponse(response, slug, request)`. The new signature is `handleStatusPageRSSResponse(response, slug, request, tenantId)`:
   - Same as above: `R.findOne` adds `tenant_id` filter.
   - The `buildRSSUrl()` call passes `tenantId`.

6. **`server/routers/status-page-router.js` — apply `resolveStatusPageTenant` middleware:**
   ```js
   const { resolveStatusPageTenant } = require("../middleware/status-page-tenant");

   // Apply to all status page routes
   router.get("/status/:slug", resolveStatusPageTenant, async (request, response) => {
       const { tenantId, slug } = request.statusPageTenant;
       await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug, tenantId);
   });

   router.get("/status/:slug/rss", resolveStatusPageTenant, async (request, response) => {
       const { tenantId, slug } = request.statusPageTenant;
       await StatusPage.handleStatusPageRSSResponse(response, slug, request, tenantId);
   });

   router.get("/status", resolveStatusPageTenant, async (request, response) => {
       const { tenantId, slug } = request.statusPageTenant;
       await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug, tenantId);
   });

   router.get("/status-page", resolveStatusPageTenant, async (request, response) => {
       const { tenantId, slug } = request.statusPageTenant;
       await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug, tenantId);
   });

   router.get("/api/status-page/:slug", resolveStatusPageTenant, async (request, response) => {
       const { tenantId, slug } = request.statusPageTenant;
       const statusPage = await R.findOne("status_page", " tenant_id = ? AND slug = ? AND published = 1 ", [tenantId, slug]);
       // ... existing getStatusPageData logic but scoped ...
   });

   // Same pattern for /api/status-page/heartbeat/:slug, /api/status-page/:slug/manifest.json,
   // /api/status-page/:slug/incident-history, /api/status-page/:slug/badge
   ```

7. **`server/server.js` — entry page routing refactor:**
   The existing block (lines ~264-285) checks `StatusPage.domainMappingList[hostname]`. The refactored version:
   ```js
   const domainInfo = StatusPage.domainMappingList[hostname];
   if (domainInfo) {
       server.entryPage = "statusPage-" + domainInfo.slug;
       // Set tenant context for the entry page request
       // (the actual redirect happens in the existing entry-page handler)
   }
   ```

8. **`docs/architecture/status-page-routing.md`** — document:
   - Resolution priority order (custom domain → subdomain → path → session/JWT → default).
   - How `resolveStatusPageTenant` is registered.
   - How `loadDomainMappingList()` maps domains to `(tenantId, slug)`.
   - Mermaid sequence diagram for a public status page request.

9. **JSDoc** on every new method.

## Interfaces/contracts and integration points

- **Upstream consumers (G2):** `resolveTenant()` middleware from `task-10` — the status page resolution is a separate middleware for public routes (no auth) but follows the same priority order documented in ADR-0003.
- **Upstream consumers (G1):** `tenant` table (slug, status), `status_page` table (tenant_id, slug, published), `status_page_cname` table (domain, status_page_id).
- **Upstream consumers (G4):** `findOneForTenant` from `task-17` — can be used in `resolveStatusPageTenant` but direct `R.findOne` is acceptable for the resolution middleware itself (it's a cross-tenant lookup, not a tenant-scoped query).
- **Downstream consumers (task-25):** `req.statusPageTenant` is the contract — `{ tenantId, slug }`. Task 25 uses this to scope every data query.
- **Downstream consumers (task-26):** `StatusPage.domainMappingList` shape `{ "domain.com": { tenantId, slug } }` is consumed by the custom domain wizard's validation.
- **Behavioral parity contract:**
  - Single-tenant deployment (default tenant, default slug) continues to work — the resolution falls through to strategy 5 (default tenant).
  - Existing `StatusPage.domainMappingList` consumers (entry page, `sendStatusPageList`) must be updated to handle the new value shape `{ tenantId, slug }` instead of the old `"slug"` string.

## Acceptance criteria

- [ ] `server/middleware/status-page-tenant.js` exists with `resolveStatusPageTenant` middleware implementing all 5 resolution strategies in order.
- [ ] `StatusPage.loadDomainMappingList()` builds `{ "domain.com": { tenantId, slug } }` instead of `{ "domain.com": "slug" }`.
- [ ] `StatusPage.handleStatusPageResponse()` accepts and uses `tenantId` parameter.
- [ ] `StatusPage.handleStatusPageRSSResponse()` accepts and uses `tenantId` parameter.
- [ ] All 9 routes in `server/routers/status-page-router.js` apply `resolveStatusPageTenant` middleware.
- [ ] `server/server.js` entry-page routing handles the new `domainMappingList` value shape.
- [ ] `docs/architecture/status-page-routing.md` exists with resolution priority and mermaid diagram.
- [ ] Single-tenant backward compat: `GET /status/default` resolves to default tenant's default status page.
- [ ] Custom domain: `GET /status` with `Host: my-company.com` (where `my-company.com` is in `status_page_cname`) resolves to the correct tenant's status page.
- [ ] `npm run lint` passes on all modified files.
- [ ] Existing status page tests in `test/backend-test/` pass without regression.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Confirm middleware exists
test -f server/middleware/status-page-tenant.js && echo "OK: middleware" || echo "MISSING: middleware"

# 2. Confirm resolution priority order in middleware
grep -c "Custom domain lookup\|Subdomain\|Path-based\|Session/JWT\|Default tenant" server/middleware/status-page-tenant.js

# 3. Confirm loadDomainMappingList returns { tenantId, slug }
grep -A 10 "loadDomainMappingList" server/model/status_page.js | grep -E "tenantId|tenant_id"

# 4. Confirm handleStatusPageResponse signature
grep "handleStatusPageResponse" server/model/status_page.js | grep "tenantId"

# 5. Confirm all routes have resolveStatusPageTenant
grep -c "resolveStatusPageTenant" server/routers/status-page-router.js

# 6. Confirm docs exist
test -f docs/architecture/status-page-routing.md && echo "OK: docs" || echo "MISSING: docs"

# 7. Lint
npx eslint server/middleware/status-page-tenant.js server/model/status_page.js server/routers/status-page-router.js server/server.js

# 8. Regression
npm run test-backend 2>&1 | tail -20
```

## Reviewer

Backend lead / Uptime Kuma maintainer. Must verify the resolution priority order matches ADR-0003, the domain mapping shape is backward-compatible, and all 9 status page routes are protected by the new middleware.

## Explicit out-of-scope items

- **Tenant-scoped data queries** — task 25 owns the scoping of `getStatusPageData()`, `getRSSPageData()`, `getIncidentHistory()`, `getMaintenanceList()`, `Group.toPublicJSON()`, and all socket handlers.
- **Tenant-specific branding** (logo, color, title, favicon) — task 25 owns the `renderHTML()` injection of tenant-specific `<meta>` / `<title>` / `<link>` tags.
- **Custom domain wizard UI** — task 26 owns the CNAME validation, SSL auto-issuance documentation, and the `saveStatusPage` domain validation logic.
- **Reverse proxy config generation** (Caddy/Nginx) — task 26 owns `extra/generate-caddy-config.js`.
- **G6 test suite** — task 26 owns `test/backend-test/test-tenant-status-page.js`.
- **SEO meta tags per tenant** — task 25 owns the SSR injection.
- **CDN cache headers** — task 26 owns `Cache-Control` header tuning.
- **Frontend changes** — G7 owns the UI (tenant switcher in status page admin, onboarding wizard).## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-26T13:18:00Z
- Verification: PR #58 review (branch feat/g6-24-status-page-tenant-resolution @ d6ab3519, Nova implementer via KUM-226). Verified per task checklist: new server/middleware/status-page-tenant.js freezes the 5-strategy priority — custom domain (status_page_cname, published only) → subdomain (first label under UPTIME_KUMA_BASE_DOMAIN = tenant.slug, active tenants) → path (/<tenant-slug>/status...) → session/JWT (request.user.tenantId) → default tenant fallback; match-but-miss host strategies documented to fall through to default tenant page (legacy behavior preserved); req.statusPageTenant = { tenantId, slug } attached with self-answer 404 JSON when nothing resolves; StatusPage.loadDomainMappingList() returns { "domain.com": { tenantId, slug } } for published pages; all 9 status page routes mount resolveStatusPageTenant before apicache; cache keys namespaced via appendKey; handleStatusPageResponse/handleStatusPageRSSResponse scope lookups by slug AND tenant_id; handler signatures frozen with trailing tenantId threaded into renderHTML/buildRSSUrl (reserved for task-25 branding). Checks run by CTO at head d6ab3519: npm run lint clean; npm run tsc clean; GitHub Actions "Lint, tsc, build (Node 20)" green on PR head; node --test backend suite on Node 22 excluding Testcontainers-requiring files (test-migration.js, test-snmp.js) per board directive D-016 = 345/347 pass, both failures triaged non-blocking (test-uptime-calculator fails identically on origin/master — pre-existing; test-domain.js timeout flake passes 18/18 on rerun). Review-requested doc additions landed in docs-only commit d6ab3519 (strategy-5 match-but-miss documented in docs/architecture/status-page-routing.md +1 line; task-26 test case k extended to pin the fallback in both directions); stray debug console.error confirmed absent from committed tree. Acceptance criteria from task file: all satisfied.
- Commit or artifact reference: PR #58 squash merge 28b4ab28 (feat(G6): tenant-resolving status page routing contract). Unblocks KUM-228/G6.25 (status page data layer tenant scoping + branding injection).
