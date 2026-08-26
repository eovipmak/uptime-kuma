/**
 * G6.24 — Status-page tenant resolution middleware (ADR-0003 §status pages).
 *
 * This is the FROZEN G6 resolution contract consumed by tasks 25/26: every
 * public status-page request resolves to a `(tenantId, slug)` pair BEFORE any
 * data query runs, and the result is attached to
 *
 *     request.statusPageTenant = { tenantId, slug }
 *
 * Resolution priority (task-24 / ADR-0003) — MUST NOT be reordered:
 *   1. Custom domain lookup — exact hostname match against
 *      `status_page_cname.domain` → the mapped status page must be published.
 *      Page-level CNAME mapping wins over tenant-level host matching because
 *      it is strictly more specific.
 *   2. Subdomain — first label of a host under `UPTIME_KUMA_BASE_DOMAIN`
 *      (same rule as G2.10 `resolveTenant()`) maps to `tenant.slug`; the
 *      tenant must be active and own a published page for the requested slug.
 *   3. Path-based — `/<tenant-slug>/status...` first path segment maps to
 *      `tenant.slug`. Dormant on today's routes (`/status/:slug` never has a
 *      tenant prefix); kept here so the contract holds when prefixed routes
 *      are wired up (G7 SPA routing / task-26 wizard deep links). Reserved
 *      first segments (`api`, `assets`, ...) never resolve as tenant slugs.
 *      The `(?:\/|$)` boundary also keeps look-alike paths such as
 *      `/api/status-page/:slug` from matching with segment `api`.
 *   4. Session/JWT — the G2 tenant context already resolved onto
 *      `request.user.tenantId` by the router-level `resolveTenant()` mount
 *      (hostname/header/JWT sources per ADR-0003 steps 1–5). Anonymous
 *      requests usually arrive here too (hostname/default resolved), so this
 *      strategy still requires an actual published page match before it wins.
 *   5. Default tenant — `default` tenant + requested slug; keeps single-tenant
 *      deployments working exactly as before (`GET /status/default`).
 *
 * When every strategy fails the middleware answers 404 itself — handlers
 * downstream can trust `request.statusPageTenant` unconditionally.
 */

const { R } = require("redbean-node");
const { log } = require("../../src/util");
const {
    DEFAULT_TENANT_SLUG,
    extractRequestHostname,
    getBaseDomain,
    isSubdomainHostname,
} = require("./resolve-tenant");

/**
 * Slug served when the URL does not carry one (`/status`, `/status-page`).
 * @type {string}
 */
const DEFAULT_SLUG = "default";

/**
 * First path segments that are application routes and must never be read as
 * a tenant slug by the path-based resolution strategy (defense in depth on
 * top of the regex boundary).
 * @type {Set<string>}
 */
const RESERVED_PATH_SEGMENTS = new Set([
    "api",
    "assets",
    "upload",
    "metrics",
    "badge",
    "settings",
    "socket.io",
]);

/**
 * Path strategy pattern: `/<tenant-slug>/status` with a segment boundary so
 * `api/status-page/...` cannot false-positive with tenant slug `api`.
 * @type {RegExp}
 */
const PATH_TENANT_PATTERN = /^\/([a-z0-9-]+)\/status(?:\/|$)/;

/**
 * Extract the status-page slug the URL asks for, normalized the same way the
 * model layer does (lower-cased, trailing-slash/index.html artifacts folded
 * to the default slug).
 * @param {object} request Express request
 * @returns {string} Requested status page slug
 */
function getRequestedSlug(request) {
    let slug = request.params.slug || DEFAULT_SLUG;
    if (slug === "index.html") {
        slug = DEFAULT_SLUG;
    }
    return String(slug).toLowerCase();
}

/**
 * Find a PUBLISHED status page owned by a tenant for the given slug.
 * Public routing only ever serves published pages — drafts are edited via the
 * authenticated socket surface, not the public HTTP one.
 * @param {number} tenantId Tenant that must own the page
 * @param {string} slug Status page slug
 * @returns {Promise<object|null>} Status page bean or null
 */
async function findPublishedPageForTenant(tenantId, slug) {
    return await R.findOne("status_page", " tenant_id = ? AND slug = ? AND published = 1 ", [ tenantId, slug ]);
}

/**
 * Resolve `(tenantId, slug)` for the incoming status-page request following
 * the frozen 5-strategy priority. On success attaches
 * `request.statusPageTenant` and calls `next()`; on total failure responds
 * 404 without calling `next()`.
 * @param {object} request Express request
 * @param {object} response Express response
 * @param {Function} next Express next callback
 * @returns {Promise<void>}
 */
async function resolveStatusPageTenant(request, response, next) {
    try {
        const hostname = await extractRequestHostname(request);
        const slug = getRequestedSlug(request);

        // 1. Custom domain lookup — status_page_cname maps the exact hostname
        // to a specific status page (published only).
        if (hostname) {
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- hostname→page mapping is the resolution input; no tenant scope exists yet (G6.24)
            const cname = await R.findOne("status_page_cname", " domain = ? ", [ hostname ]);
            if (cname) {
                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- same as above: deriving the tenant, not querying inside one
                const statusPage = await R.findOne("status_page", " id = ? AND published = 1 ", [ cname.status_page_id ]);
                if (statusPage) {
                    request.statusPageTenant = {
                        tenantId: Number(statusPage.tenant_id),
                        slug: statusPage.slug,
                    };
                    return next();
                }
            }
        }

        // 2. Subdomain — `<label>.<base domain>` resolves the tenant by slug,
        // then requires a published page for the requested slug.
        const baseDomain = getBaseDomain();
        if (hostname && baseDomain && isSubdomainHostname(hostname, baseDomain)) {
            const label = hostname.slice(0, hostname.length - baseDomain.length - 1).split(".")[0];
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- subdomain→tenant lookup seeds the scope (G6.24)
            const tenant = await R.findOne("tenant", " slug = ? AND status = 'active' ", [ label ]);
            const statusPage = tenant ? await findPublishedPageForTenant(tenant.id, slug) : null;
            if (statusPage) {
                request.statusPageTenant = {
                    tenantId: Number(statusPage.tenant_id),
                    slug: statusPage.slug,
                };
                return next();
            }
        }

        // 3. Path-based — `/<tenant-slug>/status...` first path segment.
        // Dormant until tenant-prefixed status routes exist (see file header).
        const pathMatch = PATH_TENANT_PATTERN.exec(request.path);
        if (pathMatch && !RESERVED_PATH_SEGMENTS.has(pathMatch[1])) {
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- path→tenant lookup seeds the scope (G6.24)
            const tenant = await R.findOne("tenant", " slug = ? AND status = 'active' ", [ pathMatch[1] ]);
            const statusPage = tenant ? await findPublishedPageForTenant(tenant.id, slug) : null;
            if (statusPage) {
                request.statusPageTenant = {
                    tenantId: Number(statusPage.tenant_id),
                    slug: statusPage.slug,
                };
                return next();
            }
        }

        // 4. Session/JWT — the tenant context G2's resolveTenant() already put
        // on request.user (JWT claim tid, membership-checked header, or host
        // resolution). Wins only when it actually owns a published page.
        if (request.user && request.user.tenantId != null) {
            const statusPage = await findPublishedPageForTenant(request.user.tenantId, slug);
            if (statusPage) {
                request.statusPageTenant = {
                    tenantId: Number(statusPage.tenant_id),
                    slug: statusPage.slug,
                };
                return next();
            }
        }

        // 5. Default tenant fallback — single-tenant backward compatibility:
        // `/status/default` keeps resolving without any host/subdomain setup.
        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- default tenant lookup seeds the scope (G6.24)
        const defaultTenant = await R.findOne("tenant", " slug = ? ", [ DEFAULT_TENANT_SLUG ]);
        if (defaultTenant) {
            const statusPage = await findPublishedPageForTenant(defaultTenant.id, slug);
            if (statusPage) {
                request.statusPageTenant = {
                    tenantId: Number(statusPage.tenant_id),
                    slug: statusPage.slug,
                };
                return next();
            }
        }

        log.debug("status-page-tenant", `No status page resolved for host "${hostname}" path "${request.path}".`);
        respondNotFound(request, response);
    } catch (error) {
        next(error);
    }
}

/**
 * Answer 404 for an unresolvable status-page request. HTML shell routes
 * (`/status...`) keep the pre-multi-tenant behavior of serving the SPA index
 * with a 404 status (the Vue router renders its own "not found" view); API
 * routes get a plain JSON error. Falls back to JSON whenever the server
 * instance is not available (e.g. unit tests).
 * @param {object} request Express request
 * @param {object} response Express response
 * @returns {void}
 */
function respondNotFound(request, response) {
    if ((request.originalUrl || request.url || "").startsWith("/status")) {
        try {
            // Lazy require: keeps this middleware importable in isolation and
            // avoids a server ↔ middleware require cycle.
            const { UptimeKumaServer } = require("../uptime-kuma-server");
            const indexHTML = UptimeKumaServer.getInstance().indexHTML;
            if (indexHTML) {
                response.status(404).send(indexHTML);
                return;
            }
        } catch (e) {
            // Server not initialized — fall through to the JSON body.
        }
    }
    response.status(404).json({
        message: "Status Page not found",
    });
}

module.exports = {
    resolveStatusPageTenant,
};
