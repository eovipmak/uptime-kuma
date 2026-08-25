/**
 * Tenant-safe data-access surface (G4.17, KUM-33) — ergonomic re-export.
 *
 * Import style for task-18/19/20 and later phases:
 *   const { findOneForTenant, findForTenant, execForTenant, dispenseForTenant, tenantCacheKey } = require("../repository");
 */
const {
    findOneForTenant,
    findForTenant,
    findAllForTenant,
    execForTenant,
    dispenseForTenant,
    TenantScopedQueryBuilder,
} = require("./tenant-repo");
const { tenantCacheKey, tenantKeyToScope } = require("./cache-namespace");

module.exports = {
    findOneForTenant,
    findForTenant,
    findAllForTenant,
    execForTenant,
    dispenseForTenant,
    TenantScopedQueryBuilder,
    tenantCacheKey,
    tenantKeyToScope,
};
