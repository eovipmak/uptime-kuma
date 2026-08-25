/**
 * G2.10 — HTTP middleware barrel.
 *
 * Re-exports the tenant-context middleware pair (`resolveTenant`,
 * `requireTenantContext`) plus the shared helpers (`bearerAuth`,
 * `resolveTenantIdForInbound`, `isTenantGuardExemptPath`) so callers can
 * `require("../middleware")` without knowing file layout.
 */
module.exports = require("./resolve-tenant");
