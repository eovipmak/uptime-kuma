const { R } = require("redbean-node");
const jwt = require("jsonwebtoken");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { log } = require("../../src/util");

/**
 * Resolve tenant from request by checking in priority order:
 * 1. Subdomain (e.g., acme.example.com)
 * 2. Custom domain (e.g., status.acme.com)
 * 3. Header X-Tenant-ID
 * 4. Session/JWT claim
 *
 * Sets req.tenant (full bean) and req.tenantId (number) on success.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
exports.resolveTenant = async function (req, res, next) {
    try {
        const server = UptimeKumaServer.getInstance();
        let hostname = req.hostname;

        // Trust proxy if configured
        if (req.headers["x-forwarded-host"]) {
            hostname = req.headers["x-forwarded-host"];
        }

        // 1. Try subdomain-based resolution
        //    Pattern: <slug>.<base-domain>
        const baseDomain = process.env.UPTIME_KUMA_BASE_DOMAIN || "";
        if (baseDomain && hostname.endsWith("." + baseDomain)) {
            const slug = hostname.slice(0, -(baseDomain.length + 1));
            if (slug && !slug.includes(".")) {
                const tenant = await R.findOne("tenant", " slug = ? AND status = ? ", [slug, "active"]);
                if (tenant) {
                    req.tenant = tenant;
                    req.tenantId = tenant.id;
                    return next();
                }
            }
        }

        // 2. Try custom domain resolution
        const tenant = await R.findOne("tenant", " custom_domain = ? AND status = ? ", [hostname, "active"]);
        if (tenant) {
            req.tenant = tenant;
            req.tenantId = tenant.id;
            return next();
        }

        // 3. Try X-Tenant-ID header
        const headerTenantId = req.headers["x-tenant-id"];
        if (headerTenantId) {
            const parsedId = parseInt(headerTenantId, 10);
            if (!isNaN(parsedId)) {
                const tenantById = await R.findOne("tenant", " id = ? AND status = ? ", [parsedId, "active"]);
                if (tenantById) {
                    req.tenant = tenantById;
                    req.tenantId = tenantById.id;
                    return next();
                }
            }
        }

        // 4. Try JWT claim (Authorization: Bearer <token>)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.slice(7);
            try {
                const decoded = jwt.verify(token, server.jwtSecret);
                // Check if JWT contains tenant_id claim (G2 login flow)
                if (decoded.tenant_id) {
                    const tenantFromJwt = await R.findOne("tenant", " id = ? AND status = ? ", [
                        decoded.tenant_id,
                        "active",
                    ]);
                    if (tenantFromJwt) {
                        req.tenant = tenantFromJwt;
                        req.tenantId = tenantFromJwt.id;
                        return next();
                    }
                }
            } catch (jwtError) {
                // Invalid JWT, continue without tenant context
                log.debug("tenant", "JWT validation failed for tenant resolution: " + jwtError.message);
            }
        }

        // No tenant resolved - continue without tenant context
        // requireTenantContext() will catch if this is a protected route
        req.tenant = null;
        req.tenantId = null;
        next();
    } catch (error) {
        log.error("tenant", "Error in resolveTenant middleware: " + error.message);
        req.tenant = null;
        req.tenantId = null;
        next();
    }
};

/**
 * Require tenant context to be resolved.
 * Returns 400 if no tenant was resolved by resolveTenant().
 * Use this middleware after resolveTenant() on business-protected routes.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
exports.requireTenantContext = function (req, res, next) {
    if (!req.tenant || !req.tenantId) {
        return res.status(400).json({
            ok: false,
            msg: "Tenant context is required. Provide tenant via subdomain, custom domain, X-Tenant-ID header, or JWT with tenant_id claim.",
        });
    }
    next();
};

/**
 * Get tenant ID from request if resolved.
 * @param {import('express').Request} req
 * @returns {number|null} Tenant ID or null
 */
exports.getTenantId = function (req) {
    return req.tenantId || null;
};

/**
 * Check if user belongs to the tenant in context.
 * @param {number} userId
 * @param {number} tenantId
 * @returns {Promise<boolean>}
 */
exports.isUserInTenant = async function (userId, tenantId) {
    const membership = await R.findOne("tenant_user", " user_id = ? AND tenant_id = ? ", [userId, tenantId]);
    return membership !== null;
};
