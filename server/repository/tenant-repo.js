/**
 * Tenant-safe query wrapper (G4.17, KUM-33) — the frozen data-access contract for G4.
 *
 * Every tenant-owned table carries a `tenant_id` column (G1 task-05). This module
 * injects that filter into every read/write so a missing tenant context fails
 * loudly instead of silently leaking rows across tenants.
 *
 * Ownership (per-user) scoping via `user_id` stays in the call sites; tenant
 * isolation is layered on top here.
 *
 * Frozen exports consumed by task-18/19/20 and later phases:
 * - findOneForTenant / findForTenant / findAllForTenant / execForTenant / dispenseForTenant
 * - TenantScopedQueryBuilder
 *
 * G4.19 additionally ships resolveTenantId(): the documented default-tenant
 * fallback for legacy in-process callers that predate tenant threading. It is
 * deliberately loud (log.warn) so silent fallbacks are visible in the logs.
 */
const { R } = require("redbean-node");
const { log } = require("../../src/util");

// Keep in sync with DEFAULT_TENANT_SLUG in server/middleware/resolve-tenant.js.
// Duplicated as a literal instead of imported so the data layer does not pull
// in the middleware import graph (jwt/settings/database).
const DEFAULT_TENANT_SLUG = "default";

/**
 * Validate the tenant context. The wrapper never silently defaults to the
 * default tenant: if the RBAC layer failed to set context, the data layer must
 * fail loudly (a query against `undefined` would silently cross-leak).
 * @param {any} tenantId the calling tenant context (from req.user.tenantId or socket.tenantID)
 * @param {string} op caller description used in error/log messages
 * @returns {void}
 * @throws {Error} when tenantId is missing or not a finite number-like value
 */
function assertTenantId(tenantId, op) {
    if (tenantId === undefined || tenantId === null || typeof tenantId !== "number" || !Number.isFinite(tenantId)) {
        const msg = `${op}: tenantId required; got ${tenantId}`;
        log.warn("tenant-repo", msg);
        throw new Error(msg);
    }
}

/**
 * Validate a WHERE fragment handed to the wrapper. Callers must not reference
 * tenant_id themselves — the wrapper injects the filter, and a hand-written
 * one would desynchronize the positional parameter bindings.
 * @param {any} whereFragment existing WHERE fragment (without the leading WHERE keyword)
 * @param {string} op caller description used in error messages
 * @returns {void}
 * @throws {Error} when the fragment is not a non-empty string or already references tenant_id
 */
function assertWhereFragment(whereFragment, op) {
    if (typeof whereFragment !== "string" || whereFragment.trim() === "") {
        throw new Error(`${op}: whereFragment must be a non-empty string`);
    }
    if (/\btenant_id\b/i.test(whereFragment)) {
        throw new Error(
            `${op}: whereFragment must not reference tenant_id directly; the wrapper injects the tenant filter automatically`
        );
    }
}

/**
 * Resolve the tenant context for a legacy in-process caller (G4.19).
 *
 * The wrapper itself never defaults silently; this helper exists so model
 * static methods can keep their pre-tenant signatures working on single-tenant
 * installs: an omitted tenantId resolves to the seeded default tenant and the
 * fallback is announced via log.warn (never silent). When the default tenant
 * is missing, it fails loudly like the rest of the wrapper.
 * @param {any} tenantId caller-supplied tenant context; numbers pass through untouched
 * @param {string} op caller description used in log/error messages
 * @returns {Promise<number>} a finite tenant id (supplied or resolved default)
 * @throws {Error} when tenantId is invalid AND the default tenant cannot be resolved
 */
async function resolveTenantId(tenantId, op) {
    if (typeof tenantId === "number" && Number.isFinite(tenantId)) {
        return tenantId;
    }
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- the tenant registry itself is global by definition
    const tenant = await R.findOne("tenant", " slug = ? ", [ DEFAULT_TENANT_SLUG ]);
    if (!tenant) {
        const msg = `${op}: no tenantId given and the default tenant "${DEFAULT_TENANT_SLUG}" does not exist`;
        log.warn("tenant-repo", msg);
        throw new Error(msg);
    }
    log.warn("tenant-repo", `${op}: missing tenantId, falling back to default tenant ${tenant.id} (legacy single-tenant path)`);
    return tenant.id;
}

/**
 * Tenant-scoped shadow of R.findOne — appends an `AND tenant_id = ?` filter.
 * @param {string} table the RedBean table name (e.g., "monitor")
 * @param {string} whereFragment existing WHERE fragment; must not already include tenant_id
 * @param {Array} params params matching the whereFragment
 * @param {number} tenantId the calling tenant context (from req.user.tenantId or socket.tenantID)
 * @returns {Promise<object|null>} the matching bean, or null when none exists in this tenant
 * @throws {Error} when tenantId is missing or the fragment already scopes by tenant_id
 */
async function findOneForTenant(table, whereFragment, params, tenantId) {
    assertTenantId(tenantId, `findOneForTenant(${table})`);
    assertWhereFragment(whereFragment, `findOneForTenant(${table})`);
    const merged = `(${whereFragment}) AND tenant_id = ?`;
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- this file IS the tenant-scoped implementation
    return await R.findOne(table, merged, [ ...params, tenantId ]);
}

/**
 * Tenant-scoped shadow of R.find — appends an `AND tenant_id = ?` filter before
 * the trailing extraSql (ORDER BY/LIMIT), mirroring the existing call-site shape.
 * @param {string} table the RedBean table name
 * @param {string} whereFragment existing WHERE fragment; must not already include tenant_id
 * @param {Array} params params matching the whereFragment
 * @param {number} tenantId the calling tenant context
 * @param {string} extraSql optional trailing SQL such as ORDER BY/LIMIT appended after the tenant filter
 * @returns {Promise<object[]>} the matching beans of this tenant only
 * @throws {Error} when tenantId is missing or the fragment already scopes by tenant_id
 */
async function findForTenant(table, whereFragment, params, tenantId, extraSql = "") {
    assertTenantId(tenantId, `findForTenant(${table})`);
    assertWhereFragment(whereFragment, `findForTenant(${table})`);
    const merged = `(${whereFragment}) AND tenant_id = ? ${extraSql}`;
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- this file IS the tenant-scoped implementation
    return await R.find(table, merged, [ ...params, tenantId ]);
}

/**
 * Tenant-scoped shadow of R.findAll — appends an `AND tenant_id = ?` filter.
 * @param {string} table the RedBean table name
 * @param {string} whereFragment existing WHERE fragment; must not already include tenant_id
 * @param {Array} params params matching the whereFragment
 * @param {number} tenantId the calling tenant context
 * @param {string} extraSql optional trailing SQL such as ORDER BY/LIMIT appended after the tenant filter
 * @returns {Promise<object[]>} the matching beans of this tenant only
 * @throws {Error} when tenantId is missing or the fragment already scopes by tenant_id
 */
async function findAllForTenant(table, whereFragment, params, tenantId, extraSql = "") {
    assertTenantId(tenantId, `findAllForTenant(${table})`);
    assertWhereFragment(whereFragment, `findAllForTenant(${table})`);
    // R.findAll prefixes its clause with " 1=1 " (no AND), so this fragment must
    // lead with its own connective — redbean's documented whereRaw composition.
    const merged = `AND (${whereFragment}) AND tenant_id = ? ${extraSql}`;
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- this file IS the tenant-scoped implementation
    return await R.findAll(table, merged, [ ...params, tenantId ]);
}

// Matches the leading keyword of the statements this wrapper accepts.
const UPDATE_OR_DELETE = /^(UPDATE|DELETE)\b/i;
// Locates the WHERE clause; everything after it is the row-selection predicate.
const WHERE_CLAUSE = /\bWHERE\b([\s\S]*)$/i;
// A bare `id` token means the statement targets the primary key (row-scoped).
const PRIMARY_KEY_TOKEN = /\bid\b/i;

/**
 * Tenant-scoped guard for raw UPDATE/DELETE statements (R.exec shadows).
 * Appends ` AND tenant_id = ?` to the WHERE clause so a mutation can never
 * touch another tenant's rows.
 *
 * Guards:
 * - statements without a WHERE clause are always refused (table-wide mutations
 *   belong in migrations/maintenance jobs using R.exec + a documented exemption),
 * - multi-row statements (WHERE not targeting the primary key) are refused
 *   unless the caller passes `{ requireId: false }` — an intentional escape
 *   hatch that logs a warning and should be reviewed sparingly.
 * @param {string} sql UPDATE or DELETE statement with a WHERE clause; must not mention tenant_id
 * @param {Array} params params matching the statement's existing placeholders
 * @param {number} tenantId the calling tenant context
 * @param {{requireId?: boolean}} opts optional; set `requireId: false` to allow a multi-row mutation
 * @returns {Promise<void>}
 * @throws {Error} when tenantId is missing, the statement is not UPDATE/DELETE,
 * has no WHERE clause, targets multiple rows without `requireId: false`, or already mentions tenant_id
 */
async function execForTenant(sql, params, tenantId, opts) {
    assertTenantId(tenantId, "execForTenant");
    if (typeof sql !== "string" || /\btenant_id\b/i.test(sql)) {
        throw new Error(
            "execForTenant: sql must be an UPDATE/DELETE string without a hand-written tenant_id clause; the wrapper injects the tenant filter"
        );
    }
    // Trailing semicolons would terminate the statement before the injected filter.
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    if (!UPDATE_OR_DELETE.test(trimmed)) {
        throw new Error(`execForTenant: only UPDATE/DELETE statements are supported, got: ${trimmed.slice(0, 60)}`);
    }
    const match = WHERE_CLAUSE.exec(trimmed);
    if (!match) {
        throw new Error("execForTenant: refusing UPDATE/DELETE without a WHERE clause (would mutate every tenant)");
    }
    const requireId = !(opts && opts.requireId === false);
    if (!PRIMARY_KEY_TOKEN.test(match[1])) {
        if (requireId) {
            throw new Error(
                "execForTenant: WHERE clause does not target the primary key (multi-row mutation); pass { requireId: false } explicitly if this bulk change is intended"
            );
        }
        log.warn("tenant-repo", `execForTenant: multi-row mutation allowed via requireId=false: ${trimmed.slice(0, 120)}`);
    }
    // eslint-disable-next-line uptime-kuma/require-tenant-scope -- this file IS the tenant-scoped implementation (tenant filter appended above)
    await R.exec(`${trimmed} AND tenant_id = ?`, [ ...params, tenantId ]);
}

/**
 * Tenant-scoped shadow of R.dispense — presets `bean.tenant_id` so a new row is
 * born in the right tenant (a created-but-forgotten tenant_id column would be a leak).
 * @param {string} table the RedBean table name
 * @param {number} tenantId the calling tenant context
 * @returns {object} the dispensed bean with tenant_id preset (store() it as usual)
 * @throws {Error} when tenantId is missing
 */
function dispenseForTenant(table, tenantId) {
    assertTenantId(tenantId, `dispenseForTenant(${table})`);
    const bean = R.dispense(table);
    bean.tenant_id = tenantId;
    return bean;
}

/**
 * Small SELECT builder for aggregate/static-method queries (COUNT, max-id, ...)
 * that do not fit the simple findOne/find shape. Always appends the tenant
 * filter last, then executes via R.getAll/R.getRow.
 *
 * Used by task-19 for the trickier static methods in server/model/monitor.js
 * (getPreviousHeartbeat, getMonitorList, etc.).
 */
class TenantScopedQueryBuilder {

    /**
     * @param {number} tenantId the calling tenant context
     * @throws {Error} when tenantId is missing
     */
    constructor(tenantId) {
        assertTenantId(tenantId, "TenantScopedQueryBuilder");
        /** @type {number} Tenant context injected into every built query */
        this.tenantId = tenantId;
        /** @type {string|null} SELECT fragment (without the SELECT keyword) */
        this.selectFragment = null;
        /** @type {string|null} Table name (without the FROM keyword) */
        this.tableName = null;
        /** @type {{fragment: string, params: any[]}[]} Additional WHERE conditions, joined with AND */
        this.conditions = [];
    }

    /**
     * Set the SELECT projection.
     * @param {string} fragment e.g. "COUNT(*) AS cnt" or "*"
     * @returns {TenantScopedQueryBuilder} this builder (chainable)
     */
    select(fragment) {
        this.selectFragment = fragment;
        return this;
    }

    /**
     * Set the target table.
     * @param {string} table the RedBean table name
     * @returns {TenantScopedQueryBuilder} this builder (chainable)
     */
    from(table) {
        this.tableName = table;
        return this;
    }

    /**
     * Add an extra WHERE condition (joined with AND). Must not reference tenant_id;
     * the builder injects that filter itself.
     * @param {string} fragment condition fragment, e.g. "active = ?"
     * @param {Array} params optional positional params matching the fragment
     * @returns {TenantScopedQueryBuilder} this builder (chainable)
     * @throws {Error} when the fragment is empty or already references tenant_id
     */
    where(fragment, params = []) {
        assertWhereFragment(fragment, "TenantScopedQueryBuilder.where");
        this.conditions.push({
            fragment,
            params,
        });
        return this;
    }

    /**
     * Assemble the final SQL and positional params, appending the tenant filter last.
     * @param {string} extraSql optional trailing SQL such as ORDER BY/LIMIT
     * @returns {{sql: string, params: any[]}} the assembled query
     * @throws {Error} when select()/from() have not been called
     */
    build(extraSql = "") {
        if (!this.selectFragment || !this.tableName) {
            throw new Error("TenantScopedQueryBuilder.build(): select() and from() are required before building");
        }
        let sql = `SELECT ${this.selectFragment} FROM ${this.tableName}`;
        /** @type {any[]} */
        const params = [];
        if (this.conditions.length > 0) {
            sql += ` WHERE ${this.conditions.map(c => `(${c.fragment})`).join(" AND ")}`;
            for (const c of this.conditions) {
                params.push(...c.params);
            }
            sql += " AND tenant_id = ?";
        } else {
            sql += " WHERE tenant_id = ?";
        }
        params.push(this.tenantId);
        if (extraSql) {
            sql += ` ${extraSql.trim().replace(/;+\s*$/, "")}`;
        }
        return {
            sql,
            params,
        };
    }

    /**
     * Execute the built query via R.getAll (all matching rows).
     * @param {string} extraSql optional trailing SQL such as ORDER BY/LIMIT
     * @returns {Promise<object[]>} rows belonging to this tenant only
     * @throws {Error} when the query cannot be assembled
     */
    async getAll(extraSql = "") {
        const { sql, params } = this.build(extraSql);
        return await R.getAll(sql, params);
    }

    /**
     * Execute the built query via R.getRow (first matching row).
     * @returns {Promise<object|null>} the first row of this tenant, or null
     * @throws {Error} when the query cannot be assembled
     */
    async getRow() {
        const { sql, params } = this.build();
        return await R.getRow(sql, params);
    }
}

module.exports = {
    findOneForTenant,
    findForTenant,
    findAllForTenant,
    execForTenant,
    dispenseForTenant,
    TenantScopedQueryBuilder,
    resolveTenantId,
    DEFAULT_TENANT_SLUG,
};
