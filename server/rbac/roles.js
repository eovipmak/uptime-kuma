/**
 * G3 task-13 — Role enum.
 *
 * Frozen contract: the four role strings MUST match the values stored in the
 * G1 `tenant_user.role` column (lowercase snake-case). Do not rename.
 *
 * ROLE_HIERARCHY is informational only — RBAC here is an explicit allow-list
 * (see policy.js). A higher role does not "inherit" permissions implicitly;
 * the matrix in ROLES_PERMISSIONS grants each role its full set explicitly so
 * the whole surface stays auditable in one screen. Subset invariant:
 * VIEWER ⊆ MEMBER ⊆ TENANT_ADMIN ⊆ SUPER_ADMIN.
 */
const ROLES = Object.freeze({
    SUPER_ADMIN: "super_admin",
    TENANT_ADMIN: "tenant_admin",
    MEMBER: "member",
    VIEWER: "viewer",
});

const ROLE_HIERARCHY = Object.freeze([
    ROLES.SUPER_ADMIN,
    ROLES.TENANT_ADMIN,
    ROLES.MEMBER,
    ROLES.VIEWER,
]);

module.exports = { ROLES, ROLE_HIERARCHY };
