/**
 * G1.07 — Multi-tenant demo seed (dev/demo only).
 *
 * Creates three demo tenants (Acme, XYZ, 123) with a small but realistic set of
 * data each: one tenant_user membership for the instance admin, two monitors
 * (one HTTP, one TCP), one webhook notification, two tags and two monitor_tag
 * links. Every tenant-scoped row gets its `tenant_id` set — never null.
 *
 * The seed is strictly idempotent: every insert is guarded by a unique-key
 * lookup first (slug, tenant_id + name, ...), so re-running it only logs
 * "already exists; skipping" and changes nothing.
 *
 * It is gated behind a non-production guard (`isDemoSeedAllowed`): the module
 * refuses to write anything unless NODE_ENV=development or
 * UPTIME_KUMA_DEMO_SEED=1 is set.
 */
const DEMO_TENANTS = [
    {
        name: "Acme",
        slug: "acme",
        tags: [
            { name: "acme-prod", color: "#059669" },
            { name: "demo", color: "#3B82F6" },
        ],
    },
    {
        name: "XYZ",
        slug: "xyz",
        tags: [
            { name: "xyz-staging", color: "#F59E0B" },
            { name: "demo", color: "#3B82F6" },
        ],
    },
    {
        name: "123",
        slug: "123-org",
        tags: [
            { name: "123-lab", color: "#8B5CF6" },
            { name: "demo", color: "#3B82F6" },
        ],
    },
];

/**
 * Whether the current environment is allowed to run the demo seed.
 * The guard passes only when the process signals dev/demo explicitly.
 * @returns {boolean} True when seeding may write to the database
 */
function isDemoSeedAllowed() {
    return (
        process.env.NODE_ENV === "development" ||
        process.env.UPTIME_KUMA_DEMO_SEED === "1"
    );
}

/**
 * Refusal message printed/thrown when the guard rejects a run.
 * @type {string}
 */
const REFUSAL_MESSAGE = "Refusing to run outside dev/demo. Set UPTIME_KUMA_DEMO_SEED=1 to override.";

/**
 * Monitor types this seed may create. Every value MUST be a key of
 * UptimeKumaServer.monitorTypeList (server/uptime-kuma-server.js): TCP monitors
 * are registered under "port", NOT "tcp". ensureMonitor() rejects unknown
 * types at seed time so a bad constant fails fast here instead of surfacing
 * as "Unknown Monitor Type" on every beat of the seeded monitor.
 * @type {Set<string>}
 */
const VALID_MONITOR_TYPES = new Set([ "http", "port" ]);

/**
 * Find or create a tenant by its unique slug.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @param {{name: string, slug: string}} tenantDef Tenant definition from DEMO_TENANTS
 * @returns {Promise<{id: number, state: string}>} Tenant id plus "created"|"skipped"
 */
async function ensureTenant(knex, tenantDef) {
    let tenant = await knex("tenant").where("slug", tenantDef.slug).first();

    if (tenant) {
        console.log(`Tenant \`${tenantDef.slug}\` already exists; skipping`);
        return { id: tenant.id, state: "skipped" };
    }

    await knex("tenant").insert({
        name: tenantDef.name,
        slug: tenantDef.slug,
        plan: "free",
        status: "active",
        custom_domain: null,
    });
    console.log(`Tenant \`${tenantDef.slug}\` created`);

    tenant = await knex("tenant").where("slug", tenantDef.slug).first();
    return { id: tenant.id, state: "created" };
}

/**
 * Find or create the admin's tenant_admin membership for a tenant.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @param {number} tenantId Id of the tenant to attach the admin to
 * @param {number} adminUserId Id of the admin user (first created user)
 * @returns {Promise<string>} "created" or "skipped"
 */
async function ensureTenantAdminMembership(knex, tenantId, adminUserId) {
    const existing = await knex("tenant_user")
        .where({ tenant_id: tenantId, user_id: adminUserId })
        .first();

    if (existing) {
        return "skipped";
    }

    await knex("tenant_user").insert({
        tenant_id: tenantId,
        user_id: adminUserId,
        role: "tenant_admin",
    });
    return "created";
}

/**
 * Find or create a monitor inside a tenant.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @param {object} monitorDef Monitor payload (name, type, url or hostname+port)
 * @param {number} monitorDef.tenantId Owning tenant id
 * @param {number} monitorDef.userId Admin user id stored on the monitor
 * @param {string} monitorDef.name Monitor name (unique per tenant in this seed)
 * @param {string} monitorDef.type Monitor type; must be a key of
 * UptimeKumaServer.monitorTypeList ("http" or "port" for TCP) and a member of VALID_MONITOR_TYPES
 * @returns {Promise<{id: number, state: string}>} Monitor id plus "created"|"skipped"
 */
async function ensureMonitor(knex, monitorDef) {
    if (!VALID_MONITOR_TYPES.has(monitorDef.type)) {
        throw new Error(
            `Invalid monitor type "${monitorDef.type}" for monitor \`${monitorDef.name}\`. `
            + `Valid types: ${[ ...VALID_MONITOR_TYPES ].join(", ")} — must match a UptimeKumaServer.monitorTypeList key.`
        );
    }

    const existing = await knex("monitor")
        .where({ tenant_id: monitorDef.tenantId, name: monitorDef.name })
        .first();

    if (existing) {
        console.log(`Monitor \`${monitorDef.name}\` already exists; skipping`);
        return { id: existing.id, state: "skipped" };
    }

    await knex("monitor").insert({
        name: monitorDef.name,
        type: monitorDef.type,
        url: monitorDef.url || null,
        hostname: monitorDef.hostname || null,
        port: monitorDef.port || null,
        user_id: monitorDef.userId,
        tenant_id: monitorDef.tenantId,
        active: true,
    });

    const monitor = await knex("monitor")
        .where({ tenant_id: monitorDef.tenantId, name: monitorDef.name })
        .first();
    console.log(`Monitor \`${monitorDef.name}\` created`);
    return { id: monitor.id, state: "created" };
}

/**
 * Find or create a webhook notification inside a tenant. The provider config is
 * stored as JSON in the `config` column, matching server/notification.js save().
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @param {object} notifDef Notification definition
 * @param {number} notifDef.tenantId Owning tenant id
 * @param {number} notifDef.userId Admin user id stored on the notification
 * @param {string} notifDef.name Notification name (unique per tenant in this seed)
 * @param {string} notifDef.slug Tenant slug used to build the demo webhook URL
 * @returns {Promise<string>} "created" or "skipped"
 */
async function ensureNotification(knex, notifDef) {
    const existing = await knex("notification")
        .where({ tenant_id: notifDef.tenantId, name: notifDef.name })
        .first();

    if (existing) {
        console.log(`Notification \`${notifDef.name}\` already exists; skipping`);
        return "skipped";
    }

    await knex("notification").insert({
        name: notifDef.name,
        active: true,
        user_id: notifDef.userId,
        is_default: false,
        config: JSON.stringify({
            applyExisting: false,
            isDefault: false,
            name: notifDef.name,
            type: "webhook",
            webhookURL: `https://example.com/webhook/${notifDef.slug}`,
            webhookContentType: "json",
        }),
        tenant_id: notifDef.tenantId,
    });
    console.log(`Notification \`${notifDef.name}\` created`);
    return "created";
}

/**
 * Find or create a tag inside a tenant.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @param {object} tagDef Tag definition
 * @param {number} tagDef.tenantId Owning tenant id
 * @param {string} tagDef.name Tag name (unique per tenant in this seed)
 * @param {string} tagDef.color Tag color hex value (NOT NULL column)
 * @returns {Promise<{id: number, state: string}>} Tag id plus "created"|"skipped"
 */
async function ensureTag(knex, tagDef) {
    let tag = await knex("tag")
        .where({ tenant_id: tagDef.tenantId, name: tagDef.name })
        .first();

    if (tag) {
        console.log(`Tag \`${tagDef.name}\` already exists; skipping`);
        return { id: tag.id, state: "skipped" };
    }

    await knex("tag").insert({
        name: tagDef.name,
        color: tagDef.color,
        tenant_id: tagDef.tenantId,
    });
    console.log(`Tag \`${tagDef.name}\` created`);

    tag = await knex("tag")
        .where({ tenant_id: tagDef.tenantId, name: tagDef.name })
        .first();
    return { id: tag.id, state: "created" };
}

/**
 * Find or create a monitor_tag link. monitor_tag has no tenant_id column;
 * tenancy flows through the linked monitor and tag.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @param {{monitorId: number, tagId: number}} link Monitor/tag ids to connect
 * @returns {Promise<string>} "created" or "skipped"
 */
async function ensureMonitorTag(knex, link) {
    const existing = await knex("monitor_tag")
        .where({ monitor_id: link.monitorId, tag_id: link.tagId })
        .first();

    if (existing) {
        return "skipped";
    }

    await knex("monitor_tag").insert({
        monitor_id: link.monitorId,
        tag_id: link.tagId,
        value: null,
    });
    return "created";
}

/**
 * Seed all demo tenants. Idempotent and guarded: throws before any query when
 * the environment does not allow demo seeding.
 * @param {Knex} knex A knex instance connected to the Uptime Kuma database
 * @returns {Promise<object>} Per-table counts of created and skipped rows
 */
async function seed(knex) {
    if (!isDemoSeedAllowed()) {
        throw new Error(REFUSAL_MESSAGE);
    }

    // The setup wizard creates exactly one admin on a fresh install; use the
    // first-created account as the owner of every seeded row.
    const admin = await knex("user").orderBy("id").first();

    if (!admin) {
        throw new Error(
            "No admin user found. Run the setup wizard first (start Uptime Kuma once and create the admin account), then re-run this seed."
        );
    }

    const summary = {
        created: {
            tenant: 0,
            tenant_user: 0,
            monitor: 0,
            notification: 0,
            tag: 0,
            monitor_tag: 0,
        },
        skipped: {
            tenant: 0,
            tenant_user: 0,
            monitor: 0,
            notification: 0,
            tag: 0,
            monitor_tag: 0,
        },
    };

    /**
     * Count an ensure* result into the summary.
     * @param {string} state Either "created" or "skipped"
     * @param {string} table Table name key in the summary
     * @returns {void}
     */
    const count = (state, table) => {
        summary[state][table] += 1;
    };

    for (const tenantDef of DEMO_TENANTS) {
        const tenant = await ensureTenant(knex, tenantDef);
        count(tenant.state, "tenant");

        count(await ensureTenantAdminMembership(knex, tenant.id, admin.id), "tenant_user");

        const httpMonitor = await ensureMonitor(knex, {
            tenantId: tenant.id,
            userId: admin.id,
            name: `${tenantDef.name} Website`,
            type: "http",
            url: "https://example.com",
        });
        count(httpMonitor.state, "monitor");

        const tcpMonitor = await ensureMonitor(knex, {
            tenantId: tenant.id,
            userId: admin.id,
            name: `${tenantDef.name} API`,
            type: "port",
            hostname: "example.com",
            port: 443,
        });
        count(tcpMonitor.state, "monitor");

        count(
            await ensureNotification(knex, {
                tenantId: tenant.id,
                userId: admin.id,
                name: `${tenantDef.name} Webhook`,
                slug: tenantDef.slug,
            }),
            "notification"
        );

        const tagResults = [];
        for (const tagDef of tenantDef.tags) {
            tagResults.push(await ensureTag(knex, { tenantId: tenant.id, ...tagDef }));
            count(tagResults[tagResults.length - 1].state, "tag");
        }

        // Two links per tenant: first tag on the HTTP monitor, second on the TCP monitor
        count(await ensureMonitorTag(knex, { monitorId: httpMonitor.id, tagId: tagResults[0].id }), "monitor_tag");
        count(await ensureMonitorTag(knex, { monitorId: tcpMonitor.id, tagId: tagResults[1].id }), "monitor_tag");
    }

    return summary;
}

module.exports = {
    DEMO_TENANTS,
    isDemoSeedAllowed,
    seed,
};
