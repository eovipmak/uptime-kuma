/**
 * G3 task-13 — Permission enum (single source of truth for the RBAC matrix).
 *
 * Frozen contract: keys and values share the SCREAMING_TO_DOTTED shape so a
 * grep for either the symbol or the literal finds both call sites and the
 * declaration. The list is ADDITIVE ONLY — never rename or drop a key;
 * downstream tasks (14/15 enforcement sweeps, 16 test suite) depend on the
 * string identity.
 */
const PERMISSIONS = Object.freeze({
    // Monitor domain
    MONITOR_CREATE: "monitor.create",
    MONITOR_UPDATE: "monitor.update",
    MONITOR_DELETE: "monitor.delete",
    MONITOR_READ: "monitor.read",
    MONITOR_PAUSE_RESUME: "monitor.pause_resume",

    // Notification domain
    NOTIFICATION_CREATE: "notification.create",
    NOTIFICATION_UPDATE: "notification.update",
    NOTIFICATION_DELETE: "notification.delete",
    NOTIFICATION_READ: "notification.read",

    // Status page domain
    STATUS_PAGE_CREATE: "status_page.create",
    STATUS_PAGE_UPDATE: "status_page.update",
    STATUS_PAGE_DELETE: "status_page.delete",
    STATUS_PAGE_READ: "status_page.read",

    // Shared/operator domains (single-handler shape preserved by design)
    TAG_MANAGE: "tag.manage",
    MAINTENANCE_MANAGE: "maintenance.manage",
    INCIDENT_MANAGE: "incident.manage",

    // Infrastructure domains
    PROXY_MANAGE: "proxy.manage",
    DOCKER_HOST_MANAGE: "docker_host.manage",
    API_KEY_MANAGE: "api_key.manage",
    MONITOR_GROUP_MANAGE: "monitor_group.manage",

    // Tenant administration
    TENANT_USER_INVITE: "tenant.user.invite",
    TENANT_USER_REMOVE: "tenant.user.remove",
    TENANT_USER_ROLE_UPDATE: "tenant.user.role.update",
    TENANT_SETTINGS_UPDATE: "tenant.settings.update",

    // System / super-admin domain
    SYSTEM_TENANT_SUSPEND: "system.tenant.suspend",
    SYSTEM_TENANT_DELETE: "system.tenant.delete",
    SYSTEM_VIEW_ALL_TENANTS: "system.view_all_tenants",
    SYSTEM_AUDIT_LOG_READ: "system.audit_log.read",
});

module.exports = { PERMISSIONS };
