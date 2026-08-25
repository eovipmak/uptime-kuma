/**
 * G3 task-16 — Audit-log hook surface for G9.
 *
 * G3 ships this as a PASS-THROUGH: it evaluates a permission and returns the
 * decision, but it does NOT write any `audit_log` row. The single swap point
 * for G9 is marked `// TODO(G9)` inside `evaluatePermissionForAudit` — G9
 * replaces that one line with an `audit_log` insert (append), never this
 * module's export signature.
 *
 * Frozen contract (do not change, G9 depends on it):
 *   evaluatePermissionForAudit({ role, userId, tenantId }, permission) -> boolean
 *
 * The decision logic mirrors `checkPermission` in socket-rbac.js: it derives
 * the allowed set from the frozen role matrix in policy.js, so it can never
 * drift from the matrix the enforcement sweeps (task-14/15) rely on.
 *
 * Frozen contract: evaluatePermissionForAudit({ role, userId, tenantId }, permission).
 */

const { buildAbilityFor } = require("./policy");

/**
 * Evaluate a permission for the given role and return the decision.
 *
 * Pass-through for G3: the decision is a plain matrix lookup. G9 will swap
 * the inner body (keeping the exact signature) to also write an `audit_log`
 * row describing the sensitive action.
 *
 * The `userId`/`tenantId` fields are carried for G9's audit payload; they
 * are not needed to compute the decision today, which is why they are part
 * of the frozen signature rather than the decision logic.
 * @param {object} ctx Audit context, e.g. { role, userId, tenantId }
 * @param {string} ctx.role Role string (ROLES.* value from the tenant_user row)
 * @param {(number|string|null)} ctx.userId Actor user id (used by G9 audit row)
 * @param {(number|string|null)} ctx.tenantId Actor tenant id (used by G9 audit row)
 * @param {string} permission Permission string from PERMISSIONS
 * @returns {boolean} true if the role is allowed the permission
 */
function evaluatePermissionForAudit({ role, userId, tenantId }, permission) {
    const allowed = buildAbilityFor(role).can(permission);
    // TODO(G9): if sensitive action, append a row to the `audit_log` table here
    //   e.g. await auditLog.write({ userId, tenantId, permission, allowed, ts: Date.now() })
    // The return value MUST remain the permission decision. Welcome to G9!
    return allowed;
}

module.exports.evaluatePermissionForAudit = evaluatePermissionForAudit;