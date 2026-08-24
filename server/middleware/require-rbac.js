/**
 * RBAC Middleware — Express middleware for role and permission checks
 * Requires req.user.role set by G2 resolveTenant() middleware
 */

const TranslatableError = require("../translatable-error");
const { ROLES } = require("../rbac/roles");
const { buildAbilityFor } = require("../rbac/policy");

/**
 * Express middleware that checks if the user has one of the specified roles.
 * @param {...string} roles - Allowed roles (e.g., ROLES.TENANT_ADMIN, ROLES.MEMBER)
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
 * Express middleware that checks if the user has a specific permission.
 * @param {string} permission - The permission string (e.g., "monitor.create")
 * @returns {Function} Express middleware
 */
function requirePermission(permission) {
    return (req, res, next) => {
        const userRole = req.user?.role;
        if (!userRole) {
            return next(new TranslatableError("forbiddenRole"));
        }
        const ability = buildAbilityFor(userRole);
        if (!ability.can(permission)) {
            return next(new TranslatableError("forbiddenPermission"));
        }
        next();
    };
}

/**
 * Express middleware that checks if the user is a Super Admin.
 * Convenience shortcut for requireRole(ROLES.SUPER_ADMIN)
 * @returns {Function} Express middleware
 */
function requireSuperAdmin() {
    return requireRole(ROLES.SUPER_ADMIN);
}

module.exports = { requireRole, requirePermission, requireSuperAdmin };