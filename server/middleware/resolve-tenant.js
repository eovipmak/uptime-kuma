/**
 * G2.10 — HTTP tenant-context middleware (ADR-0003 §2.2).
 *
 * Two middlewares make up the HTTP tenant boundary:
 *
 * - `resolveTenant()` determines the active tenant of an incoming request and
 *   stores it on `request.user.tenantId` (+ `request.user.role`). The
 *   resolution priority is frozen by ADR-0003 and MUST NOT be reordered:
 *     1. Subdomain — first label of a host under `UPTIME_KUMA_BASE_DOMAIN`
 *        (e.g. `acme.status.example.com` → slug `acme`);
 *     2. Custom domain — exact hostname match against `tenant.custom_domain`;
 *     3. `X-Tenant-ID` header — only honored when the authenticated user is a
 *        member of that tenant (prevents cross-tenant spoofing);
 *     4. Session/JWT claim (`tid`) — issued by User.createJWT() (task-09);
 *     5. Default tenant (slug `default`) — backward compatibility for
 *        single-tenant deployments.
 *
 * - `requireTenantContext()` guards business routes: it rejects with
 *   `TranslatableError("tenantContextRequired")` when no tenant was resolved.
 *
 * `bearerAuth()` decodes an `Authorization: Bearer <jwt>` header into
 * `request.user` so the HTTP surface mirrors the socket.io JWT identity
 * (socket.io + `checkLogin()` remains the canonical auth path; the two stacks
 * are intentionally independent — do not merge their responsibilities).
 *
 * Socket.IO parity: the socket layer (task-11) must consume
 * `resolveTenantIdForInbound()` instead of re-implementing this logic, so
 * HTTP and websocket handshakes share one source of truth.
 */

const jwt = require("jsonwebtoken");
const { R } = require("redbean-node");
const { Settings } = require("../settings");
const TranslatableError = require("../translatable-error");
const { log } = require("../../src/util");

/**
 * Slug of the fallback tenant used by single-tenant deployments (G1 task-06
 * backfills every existing user into it).
 * @type {string}
 */
const DEFAULT_TENANT_SLUG = "default";

/**
 * Environment variable that configures the status base domain for subdomain
 * routing (ADR-0003), e.g. `UPTIME_KUMA_BASE_DOMAIN=status.example.com`.
 * @type {string}
 */
const BASE_DOMAIN_ENV = "UPTIME_KUMA_BASE_DOMAIN";

/**
 * API path prefixes that stay reachable WITHOUT a resolved tenant context.
 * These endpoints authenticate anonymously by design:
 * - `/api/entry-page` serves the SPA entry mapping;
 * - `/api/push/` authenticates via the monitor's `push_token`;
 * - `/api/badge/` renders public badges for embedding;
 * - `/api/status-page/` serves public status page data (G6 scopes slugs).
 * `/metrics` and the SPA/static mounts never reach the guard (they are
 * mounted earlier / matched as non-API paths).
 * @type {string[]}
 */
const TENANT_GUARD_EXEMPT_PREFIXES = [
    "/api/entry-page",
    "/api/push/",
    "/api/badge/",
    "/api/status-page/",
];

/**
 * Determine the request hostname, honoring the `trustProxy` setting and the
 * `X-Forwarded-Host` header the same way `/api/entry-page` does. Shared by
 * every caller so proxy handling stays consistent across the app.
 *
 * When trustProxy is enabled, only the first host of a comma-separated
 * `X-Forwarded-Host` list is used and a trailing `:port` is stripped.
 * @param {object} request Express request
 * @returns {Promise<string>} Lower-cased hostname without port
 */
async function extractRequestHostname(request) {
    let hostname = request.hostname || "";
    if ((await Settings.get("trustProxy")) && request.headers["x-forwarded-host"]) {
        hostname = String(request.headers["x-forwarded-host"]).split(",")[0].trim();
    }
    return hostname.toLowerCase().replace(/:\d+$/, "");
}

/**
 * Check whether a hostname is a subdomain of the given base domain
 * (e.g. `acme.status.example.com` is a subdomain of `status.example.com`,
 * but `example.com` or `notexample.com` are not).
 * @param {string} hostname Lower-cased hostname
 * @param {string} baseDomain Lower-cased base domain (no leading dot)
 * @returns {boolean} True when there is at least one label left of the base domain
 */
function isSubdomainHostname(hostname, baseDomain) {
    if (!hostname || !baseDomain) {
        return false;
    }
    return hostname.length > baseDomain.length + 1
        && hostname.endsWith("." + baseDomain);
}

/**
 * Read the configured status base domain (ADR-0003). Unset means every
 * hostname is treated as a potential custom domain — the pre-multi-tenant
 * behavior.
 * @returns {string|null} Base domain or null when not configured
 */
function getBaseDomain() {
    const value = process.env[BASE_DOMAIN_ENV];
    return value ? String(value).toLowerCase() : null;
}

/**
 * Resolve a tenant id from the hostname alone, following ADR-0003 steps 1–2:
 * first label of the base domain (subdomain → `tenant.slug`), otherwise exact
 * match against `tenant.custom_domain`. Returns null when nothing matches so
 * lower-priority sources get their turn.
 * @param {string} hostname Lower-cased request hostname
 * @returns {Promise<number|null>} Resolved tenant id or null
 */
async function resolveTenantIdByHostname(hostname) {
    if (!hostname) {
        return null;
    }

    // 1. Subdomain: `<label>.<base domain>` maps to tenant.slug === label.
    const baseDomain = getBaseDomain();
    if (baseDomain && isSubdomainHostname(hostname, baseDomain)) {
        const label = hostname.slice(0, hostname.length - baseDomain.length - 1).split(".")[0];
        const bean = await R.findOne("tenant", " slug = ? ", [ label ]);
        if (bean) {
            return bean.id;
        }
    }

    // 2. Custom domain: exact match of the full hostname (also covers hosts
    // that are NOT subdomains of the configured base domain).
    const bean = await R.findOne("tenant", " custom_domain = ? ", [ hostname ]);
    if (bean) {
        return bean.id;
    }

    return null;
}

/**
 * Find a tenant by numeric id or slug (accepts both forms, e.g. for the
 * `X-Tenant-ID` header and POST /api/switch-tenant body).
 * @param {string|number} reference Tenant id or slug
 * @returns {Promise<object|null>} Tenant bean or null
 */
async function findTenantByIdOrSlug(reference) {
    if (reference == null || reference === "") {
        return null;
    }
    if (typeof reference === "number" || /^\d+$/.test(String(reference))) {
        return await R.findOne("tenant", " id = ? ", [ parseInt(reference, 10) ]);
    }
    return await R.findOne("tenant", " slug = ? ", [ String(reference).toLowerCase() ]);
}

/**
 * Look up the membership role of a user in a tenant.
 * @param {number} userId User id
 * @param {number} tenantId Tenant id
 * @returns {Promise<string|null>} Role from `tenant_user`, or null when the user is not a member
 */
async function getMembershipRole(userId, tenantId) {
    if (!userId || !tenantId) {
        return null;
    }
    const row = await R.getRow(
        "SELECT role FROM tenant_user WHERE user_id = ? AND tenant_id = ? ",
        [ userId, tenantId ]
    );
    return row ? row.role : null;
}

/**
 * Core tenant resolution shared by the HTTP middleware and the Socket.IO
 * handshake (task-11). Implements the ADR-0003 priority exactly:
 * subdomain → custom domain → `X-Tenant-ID` header (membership-checked) →
 * JWT claim `tid` (trusted because the token is signed; revocation is
 * enforced by G2.12 force-logout) → default tenant fallback.
 * @param {object} inbound Inbound transport data: `{ hostname, tenantHeader }`
 *   where hostname may be any case (normalized internally)
 * @param {object} options Options
 * @param {object|null} options.user Authenticated principal POJO
 *   `{ id, username, tid, role }` or null for anonymous callers
 * @returns {Promise<number|null>} Resolved tenant id, or null when even the
 *   default tenant does not exist (e.g. fresh install before setup)
 */
async function resolveTenantIdForInbound(inbound, { user = null } = {}) {
    const hostname = inbound && inbound.hostname
        ? String(inbound.hostname).toLowerCase().replace(/:\d+$/, "")
        : null;

    // 1–2. Host based resolution (subdomain, then custom domain).
    const hostResolved = await resolveTenantIdByHostname(hostname);
    if (hostResolved != null) {
        return hostResolved;
    }

    // 3. X-Tenant-ID header — NEVER trusted blindly. Anonymous requests and
    // non-members fall through (cross-tenant escalation guard, ADR-0003 §2.2.3).
    const headerValue = inbound ? inbound.tenantHeader : null;
    if (headerValue && user && user.id) {
        const tenant = await findTenantByIdOrSlug(headerValue);
        if (tenant && (await getMembershipRole(user.id, tenant.id)) != null) {
            return tenant.id;
        }
        log.debug("tenant", `Ignoring X-Tenant-ID header "${headerValue}": user ${user.id} is not a member.`);
    }

    // 4. JWT claim tid — set ahead by bearerAuth()/socket auth from the
    // signed token (task-09 contract { username, h, tid, role }). Legacy
    // tokens without tid fall through to the default tenant.
    if (user && user.tid != null) {
        const tenant = await R.findOne("tenant", " id = ? ", [ user.tid ]);
        if (tenant) {
            return tenant.id;
        }
    }

    // 5. Default tenant fallback — keeps single-tenant deployments working
    // (root-domain dashboard and status pages).
    const defaultTenant = await R.findOne("tenant", " slug = ? ", [ DEFAULT_TENANT_SLUG ]);
    if (defaultTenant) {
        return defaultTenant.id;
    }

    return null;
}

/**
 * Express middleware factory: resolve the active tenant for every request
 * (ADR-0003). Idempotent — a second application short-circuits when a tenant
 * context is already present (e.g. the global mount plus the status-page
 * router mount).
 * @returns {Function} Express middleware
 */
const resolveTenant = () => async (request, response, next) => {
    try {
        if (request.user && request.user.tenantId != null) {
            next();
            return;
        }

        const hostname = await extractRequestHostname(request);
        const tenantId = await resolveTenantIdForInbound(
            {
                hostname,
                tenantHeader: request.header("X-Tenant-ID"),
            },
            {
                user: request.user || null,
            }
        );

        if (tenantId != null) {
            request.user = request.user || {};
            request.user.tenantId = tenantId;

            // Role within the RESOLVED tenant wins over the token claim so
            // G3 RBAC reads the authoritative membership role.
            if (!request.user.role && request.user.id) {
                request.user.role = await getMembershipRole(request.user.id, tenantId);
            }
        }
        next();
    } catch (error) {
        next(error);
    }
};

/**
 * Express middleware factory: guard business routes. Rejects with
 * TranslatableError("tenantContextRequired") (HTTP 400 via the middleware
 * error translator) when no tenant context was resolved.
 * @returns {Function} Express middleware
 */
const requireTenantContext = () => (request, response, next) => {
    if (!request.user || request.user.tenantId == null) {
        next(new TranslatableError("tenantContextRequired", {
            status: 400,
        }));
        return;
    }
    next();
};

/**
 * Express middleware factory: decode `Authorization: Bearer <jwt>` into
 * `request.user` ({ id, username, h, tid, role }). Requests without the
 * header stay anonymous (downstream auth decides); a PRESENT but invalid or
 * unverifiable token is rejected with 401 so failures are never silently
 * downgraded. The JWT secret is read lazily per request.
 * @param {object} options Options
 * @param {Function} options.secretProvider Optional lazy provider of the
 *   JWT secret (injectable for tests); defaults to the running server's
 *   `jwtSecret`
 * @returns {Function} Express middleware
 */
const bearerAuth = ({ secretProvider = null } = {}) => async (request, response, next) => {
    const header = request.header("Authorization") || "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) {
        next();
        return;
    }

    let decoded;
    try {
        const secret = secretProvider
            ? secretProvider()
            : require("../uptime-kuma-server").UptimeKumaServer.getInstance().jwtSecret;
        decoded = jwt.verify(match[1], secret);
    } catch (error) {
        log.debug("tenant", `Rejected invalid bearer token: ${error.message}`);
        response.status(401).json({
            status: "fail",
            msg: "authInvalidToken",
            msgi18n: true,
        });
        return;
    }

    try {
        if (!decoded || !decoded.username) {
            next();
            return;
        }
        const userBean = await R.findOne("user", " username = ? ", [ decoded.username ]);
        if (!userBean) {
            next();
            return;
        }
        request.user = {
            id: userBean.id,
            username: userBean.username,
            h: decoded.h,
            tid: decoded.tid,
            role: decoded.role,
        };
        next();
    } catch (error) {
        next(error);
    }
};

/**
 * Check whether a request path is exempt from the tenant guard
 * (`requireTenantContext`). Non-API paths (dashboard SPA, static assets,
 * public status page HTML under /status) and anonymous API endpoints listed
 * in TENANT_GUARD_EXEMPT_PREFIXES are exempt.
 * @param {string} originalUrl Raw request URL (may include query string)
 * @returns {boolean} True when the path must NOT be guarded
 */
function isTenantGuardExemptPath(originalUrl) {
    const pathname = (originalUrl || "").split("?")[0];
    if (!(pathname === "/api" || pathname.startsWith("/api/"))) {
        return true;
    }
    return TENANT_GUARD_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

module.exports = {
    DEFAULT_TENANT_SLUG,
    BASE_DOMAIN_ENV,
    TENANT_GUARD_EXEMPT_PREFIXES,
    extractRequestHostname,
    isSubdomainHostname,
    getBaseDomain,
    findTenantByIdOrSlug,
    getMembershipRole,
    resolveTenantIdByHostname,
    resolveTenantIdForInbound,
    resolveTenant,
    requireTenantContext,
    bearerAuth,
    isTenantGuardExemptPath,
};
