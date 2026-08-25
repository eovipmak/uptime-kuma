# Task G6.26 — Custom Domain Wizard, Reverse Proxy Config & G6 Acceptance Test Suite

**Phase:** G6 — Status Page Multi-Tenant
**Status:** todo
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Backend lead / DevOps lead / Uptime Kuma maintainer (G6 closing signoff)

## Objective

Deliver the remaining G6 deliverables: (1) the custom domain validation and SSL auto-issuance guidance in the `saveStatusPage` socket handler, (2) a reverse proxy configuration generator (`extra/generate-caddy-config.js`) that outputs tenant-aware Caddy/Traefik/Nginx configs, (3) proper `Cache-Control` headers for public status pages (CDN-friendly), and (4) the G6 acceptance test suite that validates the full status page pipeline end-to-end with multiple tenants — subdomain routing, custom domain routing, path routing, data isolation, branding injection, and the 3 public status page formats (HTML, RSS, JSON).

This task **closes Phase G6**.

## Prerequisites/dependencies

- **Task G6.24** reviewed and approved — `resolveStatusPageTenant` middleware, `loadDomainMappingList()` shape `{ tenantId, slug }`, `handleStatusPageResponse(..., tenantId)`.
- **Task G6.25** reviewed and approved — all status page data queries scoped to `tenantId`, `renderHTML()` injects tenant branding, socket handlers use `socket.tenantID`.
- **Phase G5** approved — `monitorListByTenant`, heartbeat path tenant-aware, Prometheus `tenant_id` label.
- **Phase G4** approved — `findOneForTenant`, `dispenseForTenant`, `execForTenant`.
- **Phase G2** approved — `socket.tenantID`, `userRoom(tenantId, userID)`.
- **Phase G1** approved — `tenant` table, `status_page` with `tenant_id`, `status_page_cname` table, demo seed (3 tenants: Acme, XYZ, 123).
- **Can run in parallel with task 25** — task 25 touches `status_page.js` static methods + `group.js` + `incident.js` + `status-page-socket-handler.js`; task 26 touches `status_page.js` instance methods (`updateDomainNameList`, `toJSON`, `toPublicJSON`) + `status-page-router.js` (domain validation) + test file + `extra/`. The file overlap is `status_page.js` and `status-page-router.js`; coordination: task 24's changes must be merged first, then 25 and 26 can rebase on top.
- **If task 24 or 25 is incomplete:** stop, report the blocker, do not write tests or config generators against unverified data-layer contracts.

## Owner / recommended agent profile

**Backend test engineer + DevOps engineer** — fluent with the Node.js test runner, Supertest, the Socket.IO harness from `task-12`/`task-16`/`task-20`/`task-23`, and reverse proxy configuration (Caddy, Traefik, Nginx). Must understand DNS validation, SSL certificate provisioning (Let's Encrypt ACME), and CDN caching best practices.

## Exact files and artifacts to create or modify

1. **Modify** `server/model/status_page.js` — `updateDomainNameList()` adds CNAME validation; `toJSON()` and `toPublicJSON()` include domain info.
2. **Modify** `server/socket-handlers/status-page-socket-handler.js` — `saveStatusPage` handler adds domain validation.
3. **Modify** `server/routers/status-page-router.js` — add `Cache-Control` headers to public routes.
4. **Create** `extra/generate-caddy-config.js` — reverse proxy config generator.
5. **Create** `extra/generate-nginx-config.js` — Nginx config generator (fallback for users not using Caddy).
6. **Create** `test/backend-test/test-tenant-status-page.js` — the G6 acceptance test suite.
7. **Create** `docs/status-page/custom-domain-setup.md` — customer-facing guide for setting up custom domains.

## Concrete implementation steps

1. **Re-read** `task-24.md` (resolution contract), `task-25.md` (data-layer scoping), `task-23.md` (G5 engine test patterns), `task-20.md` (IDOR test patterns), `task-16.md` (RBAC test patterns), and the existing `server/model/status_page.js` instance methods.

2. **`server/model/status_page.js` — `updateDomainNameList(domainNameList)` with CNAME validation:**
   ```js
   async updateDomainNameList(domainNameList) {
       // Validate each domain
       const dns = require("dns").promises;
       const validDomains = [];
       for (const domain of domainNameList) {
           try {
               // Check if domain already claimed by another tenant
               const existing = await R.findOne("status_page_cname", " domain = ? AND status_page_id != ? ", [domain, this.id]);
               if (existing) {
                   throw new Error(`Domain ${domain} is already claimed by another status page`);
               }
               // Validate domain has a CNAME pointing to our service
               const cnameRecords = await dns.resolveCname(domain);
               const expectedCname = process.env.UPTIME_KUMA_CNAME_TARGET || "status.example.com";
               if (cnameRecords.includes(expectedCname)) {
                   validDomains.push(domain);
               } else {
                   log.warn("status-page", `Domain ${domain} CNAME does not point to ${expectedCname}`);
               }
           } catch (err) {
               log.warn("status-page", `Domain validation failed for ${domain}: ${err.message}`);
           }
       }
       // Transactional update
       await R.exec("DELETE FROM status_page_cname WHERE status_page_id = ?", [this.id]);
       for (const domain of validDomains) {
           await R.exec("INSERT INTO status_page_cname (domain, status_page_id) VALUES (?, ?)", [domain, this.id]);
       }
       // Reload domain mapping
       await StatusPage.loadDomainMappingList();
       return validDomains;
   }
   ```
   The CNAME validation is **best-effort** — if DNS resolution fails (e.g., the record hasn't propagated yet), the domain is still accepted but logged as a warning. The `UPTIME_KUMA_CNAME_TARGET` env var is the expected CNAME target.

3. **`server/model/status_page.js` — `toJSON()` and `toPublicJSON()` update:**
   - `toJSON()` includes the resolved `domainNameList` via `this.getDomainNameList()`.
   - `toPublicJSON()` continues to exclude `domainNameList` (per existing contract).

4. **`server/socket-handlers/status-page-socket-handler.js` — `saveStatusPage` domain validation:**
   The existing handler calls `statusPage.updateDomainNameList(domainNameList)`. The refactored version:
   - Validates that `domainNameList` entries are unique within the tenant.
   - Calls the refactored `updateDomainNameList()` which does CNAME validation.
   - Returns the list of successfully validated domains to the client so the UI can show which domains passed validation.

5. **`server/routers/status-page-router.js` — `Cache-Control` headers:**
   Add `Cache-Control` headers to public status page routes:
   - HTML/SSR: `Cache-Control: public, max-age=300, s-maxage=60, stale-while-revalidate=300` (5 min browser, 1 min CDN).
   - JSON API: `Cache-Control: public, max-age=300, s-maxage=60` (5 min browser, 1 min CDN).
   - Heartbeat: `Cache-Control: public, max-age=60, s-maxage=30` (1 min, frequent updates).
   - RSS: `Cache-Control: public, max-age=600, s-maxage=120` (10 min).
   - Badge: `Cache-Control: public, max-age=300, s-maxage=60` (5 min).
   - Manifest: `Cache-Control: public, max-age=86400` (1 day).
   - Incident history: `Cache-Control: public, max-age=300, s-maxage=60`.

   Each route sets the header via `response.set("Cache-Control", ...)` after the existing `response.set("Content-Type", ...)`.

6. **`extra/generate-caddy-config.js` — Caddy reverse proxy config generator:**
   ```js
   /**
    * Generates a Caddyfile with tenant-aware routing for status pages.
    *
    * Usage: node extra/generate-caddy-config.js
    *
    * Reads the tenant and status_page_cname tables and outputs a Caddyfile
    * that routes custom domains to the correct tenant's status page.
    */
   const { R } = require("redbean-node");
   const fs = require("fs");

   async function generate() {
       // Bootstrap DB connection (same as server.js)
       await require("../server/database").init();
       
       const tenants = await R.find("tenant", " status = 'active' ");
       const cnames = await R.getAll("SELECT spc.domain, sp.slug, sp.tenant_id, t.slug AS tenant_slug FROM status_page_cname spc JOIN status_page sp ON sp.id = spc.status_page_id JOIN tenant t ON t.id = sp.tenant_id WHERE sp.published = 1");
       
       let caddyfile = "# Auto-generated by Uptime Kuma — do not edit manually\n";
       caddyfile += "# Regenerate: node extra/generate-caddy-config.js\n\n";
       
       // Default server
       caddyfile += "status.example.com {\n";
       caddyfile += "    reverse_proxy localhost:3001\n";
       caddyfile += "}\n\n";
       
       // Custom domains
       for (const cname of cnames) {
           caddyfile += `${cname.domain} {\n`;
           caddyfile += `    reverse_proxy localhost:3001 {\n`;
           caddyfile += `        header_up Host status.example.com\n`;
           caddyfile += `    }\n`;
           caddyfile += `}\n\n`;
       }
       
       // Subdomain wildcard
       caddyfile += "*.status.example.com {\n";
       caddyfile += "    reverse_proxy localhost:3001\n";
       caddyfile += "}\n";
       
       fs.writeFileSync("extra/generated/Caddyfile", caddyfile);
       console.log("Caddyfile written to extra/generated/Caddyfile");
   }
   
   generate().catch(console.error);
   ```

7. **`extra/generate-nginx-config.js` — Nginx config generator (fallback):**
   Similar to the Caddy generator but outputs Nginx `server` blocks with `proxy_pass` directives. Includes a note that SSL must be configured separately (certbot) since Nginx doesn't have built-in ACME.

8. **`test/backend-test/test-tenant-status-page.js`** — the G6 acceptance suite:

   - **`before`** — reuse the in-process server harness from `task-12`/`task-23`. Seed via G1 `task-07`'s demo seed (Acme, XYZ, 123).
   - **Setup helper** — `loginAsTenant(tenantSlug)` returns `{ socket, token, tenantId, userId }`.

   **Test cases:**

   a. **Subdomain resolution test:**
      - Login as tenant Acme. Create a status page with slug `"acme-status"`.
      - Make a request to `GET /status/acme-status` with `Host: acme.status.example.com`.
      - Assert response 200 and the SSR HTML contains Acme's tenant title.

   b. **Custom domain resolution test:**
      - Add a `status_page_cname` row: `"my-company.com"` → Acme's status page.
      - Reload domain mapping.
      - Make a request to `GET /status` with `Host: my-company.com`.
      - Assert response 200 and the SSR HTML contains Acme's tenant title.

   c. **Path-based resolution test:**
      - Make a request to `GET /acme/status/default` with `Host: status.example.com`.
      - Assert response 200 and the SSR HTML contains Acme's tenant title.

   d. **Cross-tenant data isolation — HTML:**
      - Login as tenant Acme. Create a status page. Create a group and add a monitor.
      - Login as tenant XYZ. Create a status page.
      - Request `GET /status/acme-page` (Acme's page). Assert the response contains Acme's monitor name.
      - Request `GET /status/xyz-page` (XYZ's page). Assert the response does NOT contain Acme's monitor name.

   e. **Cross-tenant data isolation — JSON API:**
      - Same setup. Request `GET /api/status-page/acme-page` with appropriate tenant context.
      - Assert the JSON response contains only Acme's groups/monitors.

   f. **Cross-tenant data isolation — Socket.IO:**
      - Login as tenant Acme. Emit `getStatusPage` with slug `"acme-page"`. Assert response contains Acme's data.
      - Login as tenant XYZ. Emit `getStatusPage` with slug `"acme-page"`. Assert error (not found or permission denied).

   g. **Cross-tenant data isolation — RSS:**
      - Request `GET /status/acme-page/rss` with Acme's tenant context.
      - Assert the RSS XML contains Acme's incidents.
      - Request `GET /status/xyz-page/rss` with XYZ's tenant context.
      - Assert the RSS XML does NOT contain Acme's incidents.

   h. **Tenant branding injection test:**
      - Set `tenant.custom_domain_title = "Acme Corp Status"` for Acme.
      - Request Acme's status page HTML.
      - Assert `<title>Acme Corp Status</title>` appears in the response.
      - Assert `<meta property="og:title" content="Acme Corp Status">` appears.

   i. **Cache-Control header test:**
      - Request `GET /status/acme-page`. Assert `Cache-Control` header is present with correct values.
      - Request `GET /api/status-page/acme-page`. Assert `Cache-Control` header is present.
      - Request `GET /api/status-page/heartbeat/acme-page`. Assert `Cache-Control` header is present.

   j. **Custom domain validation test:**
      - Login as tenant Acme. Emit `saveStatusPage` with `domainNameList: ["valid-domain.com", "already-claimed.com"]`.
      - Assert the response includes validation results.
      - Assert `status_page_cname` table has the validated domains.

   k. **Default tenant backward-compat test:**
      - Login as default-tenant admin.
      - Request `GET /status/default`. Assert response 200 (legacy behavior preserved).
      - Request `GET /status/default/rss`. Assert response 200.

   l. **Incident history cross-tenant test:**
      - Login as tenant Acme. Create a status page. Create an incident.
      - Login as tenant XYZ. Create a status page. Create an incident.
      - Request `GET /api/status-page/acme-page/incident-history` (public). Assert only Acme's incidents.
      - Request `GET /api/status-page/xyz-page/incident-history` (public). Assert only XYZ's incidents.

9. **`docs/status-page/custom-domain-setup.md`** — customer-facing guide:
   - Step 1: Add a CNAME record from your domain to `status.example.com`.
   - Step 2: In the Uptime Kuma status page settings, add your custom domain.
   - Step 3: Wait for DNS propagation (up to 48 hours, usually 5-30 minutes).
   - Step 4: SSL certificate is auto-provisioned via Let's Encrypt (Caddy) or manual certbot (Nginx).
   - Troubleshooting: CNAME not found, domain already claimed, SSL provisioning delay.

10. **JSDoc** on every new method.

## Interfaces/contracts and integration points

- **Upstream (task 24):** `resolveStatusPageTenant` middleware, `StatusPage.domainMappingList` shape `{ "domain.com": { tenantId, slug } }`.
- **Upstream (task 25):** `StatusPage.handleStatusPageResponse(..., tenantId)`, `StatusPage.getStatusPageData(statusPage, tenantId)`, tenant-scoped socket handlers.
- **Upstream (G5):** `monitorListByTenant` — tests verify status page heartbeat data is tenant-scoped.
- **Upstream (G4):** `findOneForTenant`, `execForTenant` from `task-17`.
- **Upstream (G2):** `socket.tenantID`, `userRoom(tenantId, userID)`.
- **Upstream (G1):** demo seed (3 tenants) from `task-07`.
- **Downstream (G9):** `Cache-Control` headers are reviewed in G9 security hardening (HTTPS enforcement, HSTS).
- **Downstream (G10):** `extra/generate-caddy-config.js` is consumed by the Golden Image's Docker Compose and Helm chart.
- **Downstream (G12):** `docs/status-page/custom-domain-setup.md` is included in the customer-facing documentation.
- **Behavioral parity:**
  - Single-tenant (default) — all existing status page tests pass; custom domain validation is skipped for the default tenant.
  - Multi-tenant — custom domain lookup is tenant-scoped; no cross-tenant domain theft.

## Acceptance criteria

- [ ] `updateDomainNameList()` validates CNAME and prevents domain squatting across tenants.
- [ ] `saveStatusPage` socket handler returns domain validation results.
- [ ] `toJSON()` includes domain info; `toPublicJSON()` excludes it.
- [ ] All 9 status page routes have `Cache-Control` headers appropriate for CDN caching.
- [ ] `extra/generate-caddy-config.js` exists and outputs a valid Caddyfile with tenant-aware routing.
- [ ] `extra/generate-nginx-config.js` exists and outputs valid Nginx config with tenant-aware routing.
- [ ] `test/backend-test/test-tenant-status-page.js` exists and covers all 12 test scenarios.
- [ ] `docs/status-page/custom-domain-setup.md` exists with clear customer-facing instructions.
- [ ] `npm run test-backend` passes with the new status page test suite and zero regression.
- [ ] `npm run lint` passes on all modified files.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Confirm CNAME validation in updateDomainNameList
grep -A 15 "updateDomainNameList" server/model/status_page.js | grep -E "CNAME|resolveCname|CNAME_TARGET"

# 2. Confirm Cache-Control headers on all public routes
grep -c "Cache-Control" server/routers/status-page-router.js

# 3. Confirm Caddy config generator exists
test -f extra/generate-caddy-config.js && echo "OK: Caddy generator" || echo "MISSING: Caddy generator"

# 4. Confirm Nginx config generator exists
test -f extra/generate-nginx-config.js && echo "OK: Nginx generator" || echo "MISSING: Nginx generator"

# 5. Confirm docs exist
test -f docs/status-page/custom-domain-setup.md && echo "OK: docs" || echo "MISSING: docs"

# 6. Run status page tests
node --test test/backend-test/test-tenant-status-page.js 2>&1 | tail -40

# 7. Lint
npx eslint server/model/status_page.js server/socket-handlers/status-page-socket-handler.js server/routers/status-page-router.js test/backend-test/test-tenant-status-page.js

# 8. Full regression
npm run test-backend 2>&1 | tail -30
```

## Reviewer

Backend lead / DevOps lead / Uptime Kuma maintainer. Must verify CNAME validation is correct, `Cache-Control` headers are CDN-friendly, config generators produce valid output, and the test suite covers all G6 Definition of Done items.

## Explicit out-of-scope items

- **Actual SSL certificate provisioning** — this task provides the config generator and CNAME validation; the actual SSL provisioning is done by Caddy (auto ACME) or certbot (manual), not by Uptime Kuma's Node.js process.
- **Wildcard SSL certificates** — out of scope; each custom domain gets its own certificate via SNI.
- **CDN integration** (Cloudflare, Fastly) — the `Cache-Control` headers make pages CDN-friendly; actual CDN configuration is a G10 DevOps concern.
- **Dynamic proxy config reload** — the generated config must be manually applied or reloaded via Caddy's admin API; G10's Golden Image can automate the reload.
- **Frontend domain wizard UI** — G7 owns the Vue component for adding/validating custom domains.
- **Tenant `logo` column** — if not in G1 schema, this task does not add it; the `renderHTML()` branding injection from task 25 uses `custom_domain_title` and `custom_domain_description` only.
- **Rate limiting on status page routes** — G9 owns rate limiting.