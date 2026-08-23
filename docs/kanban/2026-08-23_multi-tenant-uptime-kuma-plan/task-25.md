# Task G6.25 — Status Page Data Layer Tenant Scoping + Branding Injection

**Phase:** G6 — Status Page Multi-Tenant
**Status:** todo
**Reviewer:** Backend lead / Uptime Kuma maintainer

## Objective

Scope every status page data query and socket handler to the correct tenant, and inject tenant-specific branding (title, description, logo, OG tags, favicon) into the SSR-rendered HTML. This is the **data isolation** task for G6 — it ensures that `getStatusPageData()`, `getRSSPageData()`, `getIncidentHistory()`, `getMaintenanceList()`, `Group.toPublicJSON()`, and all socket handler queries are filtered by `tenant_id` using the G4 wrapper (`findOneForTenant`, `findForTenant`, `execForTenant`).

## Prerequisites/dependencies

- **Task G6.24** reviewed and approved — `resolveStatusPageTenant` middleware, `loadDomainMappingList()` shape `{ tenantId, slug }`, `handleStatusPageResponse(..., tenantId)` signature.
- **Phase G4** approved — `findOneForTenant`, `findForTenant`, `execForTenant`, `dispenseForTenant` available.
- **Phase G2** approved — `socket.tenantID`, `userRoom(tenantId, userID)`.
- **Phase G1** approved — `tenant_id` column on `status_page`, `group`, `incident`, `monitor`, `monitor_group`, `maintenance`, `maintenance_status_page`, `status_page_cname`.
- **Can run in parallel with task 26** — task 25 touches `status_page.js` static methods + `group.js` + `incident.js` + `status-page-socket-handler.js`; task 26 touches `status_page.js` instance methods (`updateDomainNameList`, `toJSON`) + `status-page-router.js` (domain validation) + test file. The file overlap is `status_page.js` only; coordination: task 24's `status_page.js` must be merged first, then 25 and 26 can rebase on top.
- **If task 24 is incomplete:** stop, report the blocker, do not write data-layer scoping against an unverified resolution contract.

## Owner / recommended agent profile

**Backend data-access engineer** — fluent with `redbean-node`, the G4 `tenant-repo.js` wrapper, and the existing `StatusPage` static methods. Must understand the `Group.toPublicJSON()` join chain (`monitor_group` → `monitor`), the `getStatusPageData()` multi-table query pattern, and the socket handler's `checkLogin(socket)` → `socket.tenantID` flow.

## Exact files and artifacts to create or modify

1. **Modify** `server/model/status_page.js` — scope all static methods to `tenantId`.
2. **Modify** `server/model/group.js` — `toPublicJSON()` and `getMonitorList()` accept `tenantId`.
3. **Modify** `server/model/incident.js` — `toPublicJSON()` accepts `tenantId` (for future use; currently identity).
4. **Modify** `server/socket-handlers/status-page-socket-handler.js` — scope all queries to `socket.tenantID`.
5. **Modify** `server/routers/status-page-router.js` — pass `tenantId` through to all data methods.
6. **Modify** `server/model/status_page.js` — `renderHTML()` injects tenant-specific branding.

## Concrete implementation steps

1. **Re-read** `task-24.md` (resolution contract), `task-17.md` (wrapper signatures), `task-11.md` (socket rooms), and the existing `server/model/status_page.js`, `server/model/group.js`, `server/socket-handlers/status-page-socket-handler.js`.

2. **`server/model/status_page.js` — static method scoping:**

   a. **`handleStatusPageResponse(response, indexHTML, slug, tenantId)`:**
      - Replace `R.findOne("status_page", " slug = ? ", [slug])` with `findOneForTenant("status_page", " slug = ? AND published = 1 ", [slug], tenantId)`.
      - If `statusPage` is null → 404; if `statusPage.tenant_id !== tenantId` → 404.

   b. **`handleStatusPageRSSResponse(response, slug, request, tenantId)`:**
      - Same `findOneForTenant` scoping as above.

   c. **`getStatusPageData(statusPage, tenantId)`:**
      - Add `tenantId` parameter.
      - The `incident` query: `R.find("incident", " status_page_id = ? AND pin = 1 AND active = 1 ORDER BY created_date DESC LIMIT 200", [statusPage.id])` stays as-is because `statusPage.id` is already tenant-scoped by the caller.
      - The `group` query: `R.find("group", " status_page_id = ? AND public = 1 ORDER BY weight", [statusPage.id])` stays as-is.
      - **However**, `Group.toPublicJSON()` (called for each group) must now accept `tenantId` and scope its `getMonitorList()` query (see step 3).

   d. **`getRSSPageData(statusPage, tenantId)`:**
      - Same pattern: `statusPage.id` is already tenant-scoped. The `R.find("incident", ...)` and the heartbeat queries (via `R.getAll(...)`) stay as-is because the `status_page_id` or `monitor_id` chain provides the tenant filter.

   e. **`getIncidentHistory(statusPageId, cursor, isPublic, tenantId)`:**
      - Add `tenantId` parameter. The existing query `R.find("incident", " status_page_id = ? AND created_date < ? ... ORDER BY created_date DESC LIMIT ?", [statusPageId, cursor, ...])` stays as-is because `statusPageId` is already tenant-scoped.

   f. **`getMaintenanceList(statusPageId, tenantId)`:**
      - Add `tenantId` parameter. Same pattern — `statusPageId` is already tenant-scoped.

   g. **`renderHTML(indexHTML, statusPage, tenantId)`:**
      - Add `tenantId` parameter.
      - After resolving the existing status page meta tags, add tenant-specific overrides:
        ```js
        // Load tenant branding
        const tenant = await R.findOne("tenant", " id = ? ", [tenantId]);
        if (tenant) {
            const title = tenant.custom_domain_title || statusPage.title;
            const description = tenant.custom_domain_description || statusPage.description;
            const icon = tenant.logo || statusPage.icon;
            // Override <title>, <meta name="description">, <meta property="og:*">, <link rel="icon">
            $("title").text(title);
            $('meta[name="description"]').attr("content", description);
            $('meta[property="og:title"]').attr("content", title);
            $('meta[property="og:description"]').attr("content", description);
            if (tenant.logo) {
                $('link[rel="icon"]').attr("href", tenant.logo);
            }
        }
        ```

   h. **`sendStatusPageList(io, socket)`:**
      - The existing query `R.find("status_page")` returns all status pages. Refactor to `R.find("status_page", " tenant_id = ? ", [socket.tenantID])` to only return the tenant's status pages.

   i. **`slugToID(slug, tenantId)`:**
      - Add `tenantId` parameter: `R.findOne("status_page", " slug = ? AND tenant_id = ? ", [slug, tenantId])`.

3. **`server/model/group.js` — `toPublicJSON(showTags, certExpiry, tenantId)`:**
   - Add `tenantId` parameter.
   - `getMonitorList()` currently queries: `SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url FROM monitor, monitor_group WHERE monitor.id = monitor_group.monitor_id AND group_id = ? ORDER BY monitor_group.weight`.
   - Refactor to: `SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url FROM monitor, monitor_group WHERE monitor.id = monitor_group.monitor_id AND monitor.tenant_id = ? AND group_id = ? ORDER BY monitor_group.weight` with `[tenantId, this.id]`.

4. **`server/socket-handlers/status-page-socket-handler.js` — socket handler scoping:**

   Every handler that currently does `checkLogin(socket)` gains `tenantId = socket.tenantID`:

   a. **`postIncident`:**
      - `StatusPage.slugToID(slug)` → `StatusPage.slugToID(slug, socket.tenantID)`.
      - After resolving `statusPageId`, verify the status page belongs to `socket.tenantID` before creating/updating incident.

   b. **`unpinIncident`:**
      - `R.exec("UPDATE incident SET pin = 0 WHERE status_page_id = ?", [statusPageId])` → add tenant safety: `R.exec("UPDATE incident SET pin = 0 WHERE status_page_id = ? AND status_page_id IN (SELECT id FROM status_page WHERE tenant_id = ?)", [statusPageId, socket.tenantID])`.

   c. **`getIncidentHistory`:**
      - The `isPublic` path stays as-is (no tenant context for public sockets).
      - The authenticated path: `StatusPage.getIncidentHistory(statusPageId, cursor, false, socket.tenantID)`.

   d. **`editIncident`, `deleteIncident`, `resolveIncident`:**
      - The incident lookup `R.findOne("incident", " id = ?", [incidentId])` → add tenant safety: verify `incident.status_page_id`'s `tenant_id` matches `socket.tenantID`.

   e. **`getStatusPage`:**
      - `R.findOne("status_page", " slug = ? ", [slug])` → `findOneForTenant("status_page", " slug = ? ", [slug], socket.tenantID)`.

   f. **`saveStatusPage`:**
      - The existing code finds by slug then updates. Add tenant scoping: `findOneForTenant("status_page", " slug = ? ", [slug], socket.tenantID)`.
      - For new status pages: `dispenseForTenant("status_page", socket.tenantID)`.

   g. **`addStatusPage`:**
      - `R.dispense("status_page")` → `dispenseForTenant("status_page", socket.tenantID)`.
      - Set `bean.tenant_id = socket.tenantID`.

   h. **`deleteStatusPage`:**
      - `R.findOne("status_page", " slug = ? ", [slug])` → `findOneForTenant("status_page", " slug = ? ", [slug], socket.tenantID)`.
      - Verify ownership before cascading delete.

5. **`server/routers/status-page-router.js` — pass `tenantId` to data methods:**

   All routes that call `StatusPage.getStatusPageData()`, `StatusPage.getRSSPageData()`, `StatusPage.getIncidentHistory()`, `StatusPage.getMaintenanceList()` must pass `request.statusPageTenant.tenantId` as the new parameter.

6. **JSDoc** on every modified method signature.

## Interfaces/contracts and integration points

- **Upstream (task 24):** `req.statusPageTenant = { tenantId, slug }` from `resolveStatusPageTenant`.
- **Upstream (G4):** `findOneForTenant`, `findForTenant`, `execForTenant`, `dispenseForTenant` from `task-17`.
- **Upstream (G2):** `socket.tenantID` from `task-11`.
- **Downstream (task 26):** `StatusPage.sendStatusPageList()` scoped by tenant — the test suite verifies cross-tenant isolation.
- **Downstream (G7):** `StatusPage.toJSON()` returns tenant-scoped data — the frontend tenant switcher displays only the current tenant's status pages.
- **Behavioral parity:**
  - Single-tenant (default tenant) — all existing queries return the same result set (backfill from `task-06` ensures all legacy rows have `tenant_id = default`).
  - Multi-tenant — tenant A's status pages are invisible to tenant B's socket.

## Acceptance criteria

- [ ] `StatusPage.handleStatusPageResponse()` uses `findOneForTenant` with `tenantId`.
- [ ] `StatusPage.getStatusPageData()` passes `tenantId` to `Group.toPublicJSON()`.
- [ ] `Group.toPublicJSON()` (and `getMonitorList()`) scope by `tenantId`.
- [ ] `StatusPage.sendStatusPageList()` only returns the current tenant's status pages.
- [ ] `StatusPage.slugToID()` accepts and uses `tenantId`.
- [ ] `StatusPage.renderHTML()` injects tenant-specific title, description, OG tags, and favicon when `tenant` table has branding columns.
- [ ] All socket handlers in `status-page-socket-handler.js` scope queries to `socket.tenantID`.
- [ ] `addStatusPage` uses `dispenseForTenant` to set `tenant_id` on new status pages.
- [ ] `deleteStatusPage` verifies tenant ownership before cascading delete.
- [ ] `npm run lint` passes on all modified files.
- [ ] `npm run test-backend` passes with zero regression.

## Verification commands/checks

Run from the repository root:

```bash
# 1. Confirm findOneForTenant usage in handleStatusPageResponse
grep -A 5 "handleStatusPageResponse" server/model/status_page.js | grep -E "findOneForTenant|tenantId"

# 2. Confirm Group.toPublicJSON has tenantId parameter
grep "toPublicJSON" server/model/group.js | grep "tenantId"

# 3. Confirm sendStatusPageList scoped
grep "sendStatusPageList" server/model/status_page.js | grep -E "tenant_id|tenantID"

# 4. Confirm slugToID has tenantId
grep "slugToID" server/model/status_page.js | grep "tenantId"

# 5. Confirm renderHTML injects tenant branding
grep -A 20 "renderHTML" server/model/status_page.js | grep -E "tenant|logo|tenantId"

# 6. Confirm socket handlers use tenantID
grep -c "socket.tenantID" server/socket-handlers/status-page-socket-handler.js

# 7. Confirm dispenseForTenant in addStatusPage
grep -A 5 "addStatusPage" server/socket-handlers/status-page-socket-handler.js | grep "dispenseForTenant"

# 8. Lint
npx eslint server/model/status_page.js server/model/group.js server/model/incident.js server/socket-handlers/status-page-socket-handler.js server/routers/status-page-router.js

# 9. Regression
npm run test-backend 2>&1 | tail -20
```

## Reviewer

Backend lead / Uptime Kuma maintainer. Must verify that every status page data query is tenant-scoped, the branding injection is correct, and socket handlers don't leak cross-tenant data.

## Explicit out-of-scope items

- **Custom domain wizard UI** — task 26 owns the `saveStatusPage` domain validation and CNAME checking.
- **Reverse proxy config generation** — task 26 owns `extra/generate-caddy-config.js`.
- **G6 test suite** — task 26 owns `test/backend-test/test-tenant-status-page.js`.
- **CDN cache headers** — task 26 owns `Cache-Control` tuning.
- **Frontend tenant switcher** — G7 owns the UI.
- **Tenant `logo` column schema** — if `tenant.logo` column doesn't exist in G1, this task uses `tenant.custom_domain_title` and `tenant.custom_domain_description` only (the `custom_domain` column was in the plan's G1 schema; logo/favicon columns are optional and can be added in a follow-up migration by task 26 if needed).
- **Status page password protection** — the existing `status_page.password` column is unused; this task does not implement per-tenant password protection.