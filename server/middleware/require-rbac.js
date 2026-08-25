/**
 * G3 task-13 — RBAC middleware for the HTTP `/api` surface.
 *
 * Consumes `req.user.role`, which G2's `bearerAuth()` + `resolveTenant()`
 * pipeline sets on every guarded route (JWT role claim, membership-resolved).
 * Route-level composition (task-15):
 *
 *     router.post("/foo", requirePermission(PERMISSIONS.FOO_CREATE), handler)
 *
 * Failures raise TranslatableError so the existing Express error boundary
 * renders them like every other middleware-layer 403.
 */

const TranslatableError = require("../translatable-error");
const { ROLES } = require("../rbac/roles");
const { buildAbilityFor } = require("../rbac/policy");

/**
 * Express middleware that allows the request only when `req.user.role` is one
 * of the given roles. A missing role is also denied.
 * @param {...string} roles - Allowed roles (e.g. ROLES.TENANT_ADMIN)
 * @returns {Function} Express middleware
 */
function requireRole(...roles) {
    return (req, res, next) => {
        const userRole = req.user?.role;
        if (!userRole || !roles.includes(userRole)) {
            return next(new TranslatableError("forbiddenRole"));
        }
        next();
    };
}

/**
 * Express middleware that allows the request only when the caller's role
 * holds the given permission per the frozen matrix in policy.js.
 * @param {string} permission - Permission string (e.g. PERMISSIONS.MONITOR_CREATE)
 * @returns {Function} Express middleware
 */
function requirePermission(permission) {
    return (req, res, next) => {
        const userRole = req.user?.role;
        if (!userRole) {
            return next(new TranslatableError("forbiddenRole"));
        }
        if (!buildAbilityFor(userRole).can(permission)) {
            return next(new TranslatableError("forbiddenPermission"));
        }
        next();
    };
}

/**
 * Convenience shortcut for `requireRole(ROLES.SUPER_ADMIN)` — the gate for
 * later system-admin (`system.*`) routes (G9).
 * @returns {Function} Express middleware
 */
function requireSuperAdmin() {
    return requireRole(ROLES.SUPER_ADMIN);
}

module.exports = { requireRole, requirePermission, requireSuperAdmin };
