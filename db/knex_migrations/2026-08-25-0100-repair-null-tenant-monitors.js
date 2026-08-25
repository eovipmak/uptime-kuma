// KUM-100 — Repair monitor rows created without a tenant_id.
//
// The "add" monitor socket handler (server/server.js) never stamped
// bean.tenant_id, so every monitor created after the G1.05 tenant-id column
// migration (2026-08-23-0001-add-tenant-id-columns.js) landed with
// tenant_id = NULL. NULL-tenant rows are invisible to the tenant-scoped
// queries introduced in G1/G2 (Monitor.listForTenantAndUser,
// UptimeKumaServer.getMonitorJSONList with an active tenant), so those
// monitors silently vanished from dashboards.
//
// Repair rule: assign each NULL-tenant monitor to its owner's primary tenant
// (lowest tenant_id membership in tenant_user). When the owner has no
// membership at all, fall back to the default tenant (slug "default").
//
// Knex methods only (no raw SQL) so SQLite and MariaDB behave identically.
// Idempotent: only rows still carrying a NULL tenant_id are touched.

const DEFAULT_TENANT_SLUG = "default";

exports.up = async function (knex) {
    // Resolved once: owners without any membership fall back here.
    const defaultTenant = await knex("tenant")
        .where("slug", DEFAULT_TENANT_SLUG)
        .first();

    const orphanRows = await knex("monitor")
        .whereNull("tenant_id")
        .select("id", "user_id");

    for (const row of orphanRows) {
        // Primary tenant = owner's lowest tenant_id membership.
        let targetTenantID = null;
        if (row.user_id != null) {
            const membership = await knex("tenant_user")
                .where("user_id", row.user_id)
                .orderBy("tenant_id")
                .first();
            targetTenantID = membership ? membership.tenant_id : null;
        }

        // No membership (or no user): default tenant stands in.
        if (targetTenantID == null && defaultTenant != null) {
            targetTenantID = defaultTenant.id;
        }

        if (targetTenantID == null) {
            // No default tenant exists either; leave the row untouched so the
            // migration chain cannot crash on a partially migrated database.
            continue;
        }

        await knex("monitor")
            .where("id", row.id)
            .update({ tenant_id: targetTenantID });
    }
};

exports.down = function (knex) {
    // Intentionally irreversible: re-stamping repaired rows back to NULL would
    // hide them from every tenant-scoped query again and could not distinguish
    // them from monitors legitimately created before tenancy existed.
    // Per the migration contract (Clause F — rollback without data loss)
    // this down() touches nothing; the "add" handler now stamps
    // bean.tenant_id, so no new NULL-tenant monitors appear.
    return Promise.resolve();
};
