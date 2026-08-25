/**
 * Tenant cache-key namespace contract (G4.17, KUM-33).
 *
 * The Redis-backed cache adapter itself does not exist yet (G10 owns it); this
 * module freezes the **key shape** that G10's adapter and every hand-written
 * key in the codebase must follow so per-tenant cleanup can scan a tenant's
 * keys without collisions:
 *
 *   tenant:${tenantId}:${key}
 */
const TENANT_KEY_PREFIX = /^tenant:(\d+):/;

/**
 * Build the tenant-namespaced cache key.
 * @param {number} tenantId the owning tenant
 * @param {string} key the tenant-local key (e.g. "monitor:42", "settings:entryPage")
 * @returns {string} namespaced key of shape `tenant:${tenantId}:${key}`
 */
const tenantCacheKey = (tenantId, key) => `tenant:${tenantId}:${key}`;

/**
 * Extract the tenant scope from a namespaced cache key (inverse of tenantCacheKey).
 * Used by G10 to scan/flush every key of one tenant on off-board cleanup.
 * @param {string} key a cache key, namespaced or not
 * @returns {number|null} the tenant id when the key is tenant-scoped, otherwise null
 */
const tenantKeyToScope = (key) => {
    const m = TENANT_KEY_PREFIX.exec(key || "");
    return m ? Number(m[1]) : null;
};

module.exports = {
    tenantCacheKey,
    tenantKeyToScope,
};
