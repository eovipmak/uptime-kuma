// G1.06 — Default-Tenant Seeding & Backward-Compatible Backfill
// Contract: docs/architecture/migration-contract.md — Clause D (default-tenant seeding),
// Clause E (idempotency) and Clause F (rollback without data loss).
//
// exports.up:
//   1. Insert the default tenant (slug "default") if it does not exist yet.
//   2. Backfill tenant_id = default tenant id on every pre-existing row of the ten
//      tables that gained the column in 2026-08-23-0001-add-tenant-id-columns.js.
//   3. Create a tenant_user membership (role "tenant_admin") for every existing user.
//
// exports.down restores the pre-migration state WITHOUT deleting any business data:
//   tenant_id is set back to NULL, then only the tenant_user rows and the default
//   tenant row created here are removed, in FK-safe order.
//
// NOT-NULL tightening decision: DEFERRED until the G4 tenant-safe query layer lands.
// Until then application code still inserts business rows without tenant_id; flipping
// the column to NOT NULL now would break every such INSERT and violate the plan's
// backward-compatibility mandate. See kanban task-06 step 9 and contract open item C1.

/**
 * Tables that gained a nullable tenant_id column in migration
 * 2026-08-23-0001-add-tenant-id-columns.js (contract Clause B).
 * Child tables (heartbeat, stat_*, monitor_tag, ...) are intentionally absent:
 * they have no tenant_id column and inherit tenancy through their parent anchor.
 * @type {string[]}
 */
const TENANT_SCOPED_TABLES = [
    "monitor",
    "group",
    "proxy",
    "docker_host",
    "notification",
    "status_page",
    "maintenance",
    "api_key",
    "tag",
    "remote_browser",
];

/**
 * Slug of the default tenant used to absorb all legacy single-tenant data.
 * @type {string}
 */
const DEFAULT_TENANT_SLUG = "default";

/**
 * Find or create the default tenant and return its id.
 * Idempotent: re-running on a database that already has the default tenant
 * returns the existing row instead of inserting a duplicate (slug is unique).
 * @param {Knex} knex The knex instance from the migration context
 * @returns {Promise<number>} The id of the default tenant
 */
async function ensureDefaultTenant(knex) {
    let tenant = await knex("tenant").where("slug", DEFAULT_TENANT_SLUG).first();

    if (!tenant) {
        await knex("tenant").insert({
            name: "Default Tenant",
            slug: DEFAULT_TENANT_SLUG,
            plan: "free",
            status: "active",
            custom_domain: null,
        });
        tenant = await knex("tenant").where("slug", DEFAULT_TENANT_SLUG).first();
    }

    return tenant.id;
}

/**
 * Seed the default tenant and backfill every legacy row into it.
 * Idempotent by construction:
 * - the default tenant insert is guarded by the unique slug lookup,
 * - `whereNull("tenant_id")` short-circuits already-backfilled tables,
 * - memberships are inserted only for users that do not have one yet,
 *   guarded by the (tenant_id, user_id) unique index.
 * Safe to call again after new rows appear (e.g. fresh-install admin creation):
 * only the missing pieces are written.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @returns {Promise<number>} The id of the default tenant
 */
async function seedDefaultTenantIfEmpty(knex) {
    const tenantId = await ensureDefaultTenant(knex);

    // Backfill every pre-existing row into the default tenant (Clause D.2)
    for (const table of TENANT_SCOPED_TABLES) {
        await knex(table).whereNull("tenant_id").update({
            tenant_id: tenantId,
        });
    }

    // Every existing user becomes tenant_admin of the default tenant (Clause D.3)
    const userIds = (await knex("user").select("id")).map((row) => row.id);
    const existingUserIds = new Set(
        await knex("tenant_user").where("tenant_id", tenantId).pluck("user_id")
    );
    const missingUserIds = userIds.filter((id) => !existingUserIds.has(id));

    if (missingUserIds.length > 0) {
        await knex("tenant_user").insert(
            missingUserIds.map((userId) => ({
                tenant_id: tenantId,
                user_id: userId,
                role: "tenant_admin",
            }))
        );
    }

    return tenantId;
}

/**
 * Apply the default-tenant seeding and backward-compatible backfill.
 * @param {Knex} knex The knex instance provided by the migration runner
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
    await seedDefaultTenantIfEmpty(knex);
};

/**
 * Rollback: restore the pre-migration state without losing business data.
 * Order matters (FK-safe): detach rows first, then delete memberships, then
 * the default tenant itself. Only rows/memberships pointing at the default
 * tenant are touched — data created before this migration is never deleted.
 * @param {Knex} knex The knex instance provided by the migration runner
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
    const tenant = await knex("tenant").where("slug", DEFAULT_TENANT_SLUG).first();

    if (!tenant) {
        return;
    }

    // 1. Detach every row that was assigned to the default tenant
    for (const table of [...TENANT_SCOPED_TABLES].reverse()) {
        await knex(table).where("tenant_id", tenant.id).update({
            tenant_id: null,
        });
    }

    // 2. Delete only the membership rows created by this migration
    await knex("tenant_user").where("tenant_id", tenant.id).del();

    // 3. Delete the default tenant row last (children reference it)
    await knex("tenant").where("id", tenant.id).del();
};

// Re-exported so post-migration callers (server/setup-database.js hook, G2's
// fresh-install admin setup in task-09) can reuse the exact same seeding logic
// without duplicating it. Knex ignores unknown exports during migrations.
exports.seedDefaultTenantIfEmpty = seedDefaultTenantIfEmpty;
