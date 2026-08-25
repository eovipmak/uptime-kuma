const { R } = require("redbean-node");
const { checkLogin } = require("../util-server");
// G3 task-14: RBAC enforcement (see per-event annotations below)
const { checkPermission } = require("../rbac/socket-rbac");
const { PERMISSIONS } = require("../rbac/permissions");
// G4.18 (KUM-34): tenant-safe query wrappers
const { findOneForTenant, execForTenant, dispenseForTenant } = require("../repository");
const dayjs = require("dayjs");
const { log } = require("../../src/util");
const ImageDataURI = require("../image-data-uri");
const Database = require("../database");
const apicache = require("../modules/apicache");
const StatusPage = require("../model/status_page");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { Settings } = require("../settings");

/**
 * Validates incident data
 * @param {object} incident - The incident object
 * @returns {void}
 * @throws {Error} If validation fails
 */
function validateIncident(incident) {
    if (!incident.title || incident.title.trim() === "") {
        throw new Error("Please input title");
    }
    if (!incident.content || incident.content.trim() === "") {
        throw new Error("Please input content");
    }
}

/**
 * Resolve a status-page slug to its row, restricted to the caller's tenant.
 * Used by every authenticated mutation path so a slug from another tenant
 * resolves to null instead of leaking the page (G4.18).
 * @param {Socket} socket Socket.io instance (socket.tenantID must be set)
 * @param {string} slug Status page slug
 * @returns {Promise<object|null>} the tenant-scoped status page bean, or null
 */
async function getSlugForTenant(socket, slug) {
    return await findOneForTenant("status_page", " slug = ? ", [slug], socket.tenantID);
}

/**
 * Socket handlers for status page
 * @param {Socket} socket Socket.io instance to add listeners on
 * @returns {void}
 */
module.exports.statusPageSocketHandler = (socket) => {
    // Post or edit incident
    socket.on("postIncident", async (slug, incident, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — incident management. Task-14 does not
            // enumerate this fork's incident events individually; INCIDENT_MANAGE
            // is the matching constant from the frozen task-13 enum (member+,
            // no new permission invented).
            checkPermission(socket, PERMISSIONS.INCIDENT_MANAGE);

            // G4.18: tenant-scoped slug resolution (replaces the global slugToID)
            let statusPage = await getSlugForTenant(socket, slug);

            if (!statusPage) {
                throw new Error("slug is not found");
            }

            const statusPageID = statusPage.id;

            let incidentBean;

            if (incident.id) {
                // G4.18 exemption: incident is parent-anchored (ADR-0002 — no
                // tenant_id column); the parent status page was verified in-tenant above.
                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- parent status_page verified in-tenant above
                incidentBean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [
                    incident.id,
                    statusPageID,
                ]);
            }

            if (incidentBean == null) {
                // G4.18 exemption: junction-child inherits tenancy from the verified parent page
                incidentBean = R.dispense("incident");
            }

            incidentBean.title = incident.title;
            incidentBean.content = incident.content;
            incidentBean.style = incident.style;
            incidentBean.pin = true;
            incidentBean.active = true;
            incidentBean.status_page_id = statusPageID;

            if (incident.id) {
                incidentBean.last_updated_date = R.isoDateTime(dayjs.utc());
            } else {
                incidentBean.created_date = R.isoDateTime(dayjs.utc());
            }

            await R.store(incidentBean);

            callback({
                ok: true,
                incident: incidentBean.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("unpinIncident", async (slug, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — incident management (see postIncident
            // annotation; INCIDENT_MANAGE, member+).
            checkPermission(socket, PERMISSIONS.INCIDENT_MANAGE);

            // G4.18: tenant-scoped slug resolution + IN-subquery pin on the
            // parent-anchored incident rows (ADR-0002)
            let statusPage = await getSlugForTenant(socket, slug);

            if (!statusPage) {
                throw new Error("slug is not found");
            }

            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- incident has no tenant_id column (ADR-0002); rows pinned via IN-subquery on status_page.tenant_id
            await R.exec(
                "UPDATE incident SET pin = 0 WHERE pin = 1 AND status_page_id = ? " +
                "AND status_page_id IN (SELECT id FROM status_page WHERE tenant_id = ?) ",
                [statusPage.id, socket.tenantID]
            );

            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("getIncidentHistory", async (slug, cursor, callback) => {
        try {
            // RBAC: read, viewer+ OK — deliberately no checkLogin/check here:
            // this read also serves public status-page contexts (isPublic
            // filtering happens inside StatusPage.getIncidentHistory).
            // G4.18 exemption: public slug resolution is G6's concern (the
            // tenant is resolved by hostname for anonymous viewers, task-18
            // out-of-scope note); StatusPage.slugToID stays until then.
            let statusPageID = await StatusPage.slugToID(slug);
            if (!statusPageID) {
                throw new Error("slug is not found");
            }

            const isPublic = !socket.userID;
            const result = await StatusPage.getIncidentHistory(statusPageID, cursor, isPublic);
            callback({
                ok: true,
                ...result,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("editIncident", async (slug, incidentID, incident, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — incident management (see postIncident
            // annotation; INCIDENT_MANAGE, member+).
            checkPermission(socket, PERMISSIONS.INCIDENT_MANAGE);

            // G4.18: tenant-scoped slug resolution (replaces the global slugToID)
            let statusPage = await getSlugForTenant(socket, slug);
            if (!statusPage) {
                callback({
                    ok: false,
                    msg: "slug is not found",
                    msgi18n: true,
                });
                return;
            }
            const statusPageID = statusPage.id;

            // G4.18 exemption: incident is parent-anchored (ADR-0002 — no
            // tenant_id column); the parent page was verified in-tenant above.
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- parent status_page verified in-tenant above
            let bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            try {
                validateIncident(incident);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: true,
                });
                return;
            }

            const validStyles = ["info", "warning", "danger", "primary", "light", "dark"];
            if (!validStyles.includes(incident.style)) {
                incident.style = "warning";
            }

            bean.title = incident.title;
            bean.content = incident.content;
            bean.style = incident.style;
            bean.pin = incident.pin !== false;
            bean.lastUpdatedDate = R.isoDateTime(dayjs.utc());

            await R.store(bean);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                incident: bean.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("deleteIncident", async (slug, incidentID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — incident management (see postIncident
            // annotation; INCIDENT_MANAGE, member+).
            checkPermission(socket, PERMISSIONS.INCIDENT_MANAGE);

            // G4.18: tenant-scoped slug resolution (replaces the global slugToID)
            let statusPage = await getSlugForTenant(socket, slug);
            if (!statusPage) {
                callback({
                    ok: false,
                    msg: "slug is not found",
                    msgi18n: true,
                });
                return;
            }
            const statusPageID = statusPage.id;

            // G4.18 exemption: incident is parent-anchored (ADR-0002 — no
            // tenant_id column); the parent page was verified in-tenant above.
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- parent status_page verified in-tenant above
            let bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            await R.trash(bean);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("resolveIncident", async (slug, incidentID, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — incident management (see postIncident
            // annotation; INCIDENT_MANAGE, member+).
            checkPermission(socket, PERMISSIONS.INCIDENT_MANAGE);

            // G4.18: tenant-scoped slug resolution (replaces the global slugToID)
            let statusPage = await getSlugForTenant(socket, slug);
            if (!statusPage) {
                callback({
                    ok: false,
                    msg: "slug is not found",
                    msgi18n: true,
                });
                return;
            }
            const statusPageID = statusPage.id;

            // G4.18 exemption: incident is parent-anchored (ADR-0002 — no
            // tenant_id column); the parent page was verified in-tenant above.
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- parent status_page verified in-tenant above
            let bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            await bean.resolve();

            callback({
                ok: true,
                msg: "Resolved",
                msgi18n: true,
                incident: bean.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("getStatusPage", async (slug, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: read, but explicitly gated with STATUS_PAGE_READ
            // (viewer+) per task-14 item 6 — status pages have both public and
            // authenticated views, so the authenticated editor read is
            // deliberate rather than default-open.
            checkPermission(socket, PERMISSIONS.STATUS_PAGE_READ);

            // G4.18: tenant-scoped editor read (the anonymous/public slug read
            // path is G6's concern and lives elsewhere)
            let statusPage = await getSlugForTenant(socket, slug);

            if (!statusPage) {
                throw new Error("No slug?");
            }

            callback({
                ok: true,
                config: await statusPage.toJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Save Status Page
    // imgDataUrl Only Accept PNG!
    socket.on("saveStatusPage", async (slug, config, imgDataUrl, publicGroupList, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — updates status page config/slug/logo and
            // published group layout → STATUS_PAGE_UPDATE (tenant_admin,
            // task-13 matrix).
            checkPermission(socket, PERMISSIONS.STATUS_PAGE_UPDATE);

            // Save Config
            // G4.18: tenant-scoped editor read — another tenant's slug is "No slug?"
            let statusPage = await getSlugForTenant(socket, slug);

            if (!statusPage) {
                throw new Error("No slug?");
            }

            checkSlug(config.slug);

            const header = "data:image/png;base64,";

            // Check logo format
            // If is image data url, convert to png file
            // Else assume it is a url, nothing to do
            if (imgDataUrl.startsWith("data:")) {
                if (!imgDataUrl.startsWith(header)) {
                    throw new Error("Only allowed PNG logo.");
                }

                const filename = `logo${statusPage.id}.png`;

                // Convert to file
                await ImageDataURI.outputFile(imgDataUrl, Database.uploadDir + filename);
                config.logo = `/upload/${filename}?t=` + Date.now();
            } else {
                config.logo = imgDataUrl;
            }

            statusPage.slug = config.slug;
            statusPage.title = config.title;
            statusPage.description = config.description;
            statusPage.icon = config.logo;
            ((statusPage.autoRefreshInterval = config.autoRefreshInterval), (statusPage.theme = config.theme));
            //statusPage.published = ;
            //statusPage.search_engine_index = ;
            statusPage.show_tags = config.showTags;
            //statusPage.password = null;
            statusPage.footer_text = config.footerText;
            statusPage.custom_css = config.customCSS;
            statusPage.show_powered_by = config.showPoweredBy;
            statusPage.rss_title = config.rssTitle;
            statusPage.show_only_last_heartbeat = config.showOnlyLastHeartbeat;
            statusPage.show_certificate_expiry = config.showCertificateExpiry;
            statusPage.modified_date = R.isoDateTime();
            statusPage.analytics_id = config.analyticsId;
            statusPage.analytics_script_url = config.analyticsScriptUrl;
            const validAnalyticsTypes = ["google", "umami", "plausible", "matomo", "rybbit"];
            if (config.analyticsType !== null && !validAnalyticsTypes.includes(config.analyticsType)) {
                throw new Error("Invalid analytics type");
            }
            statusPage.analytics_type = config.analyticsType;

            await R.store(statusPage);

            await statusPage.updateDomainNameList(config.domainNameList);
            await StatusPage.loadDomainMappingList();

            // Save Public Group List
            const groupIDList = [];
            let groupOrder = 1;

            for (let group of publicGroupList) {
                let groupBean;
                if (group.id) {
                    // G4.18: group is a tenant-owned Clause-B table
                    groupBean = await findOneForTenant("group", " id = ? AND public = 1 AND status_page_id = ? ", [
                        group.id,
                        statusPage.id,
                    ], socket.tenantID);
                } else {
                    // G4.18: born into the caller's tenant
                    groupBean = dispenseForTenant("group", socket.tenantID);
                }

                groupBean.status_page_id = statusPage.id;
                groupBean.name = group.name;
                groupBean.public = true;
                groupBean.weight = groupOrder++;

                await R.store(groupBean);

                // G4.18: junction cleanup pinned to the caller's tenant's groups
                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- monitor_group has no tenant_id column (ADR-0002); rows pinned via IN-subquery on group.tenant_id
                await R.exec(
                    "DELETE FROM monitor_group WHERE group_id = ? " +
                    "AND group_id IN (SELECT id FROM `group` WHERE tenant_id = ?)", [
                        groupBean.id,
                        socket.tenantID,
                    ]
                );

                let monitorOrder = 1;

                for (let monitor of group.monitorList) {
                    // G4.18 exemption: junction row inherits tenancy from the verified parent group
                    let relationBean = R.dispense("monitor_group");
                    relationBean.weight = monitorOrder++;
                    relationBean.group_id = groupBean.id;
                    relationBean.monitor_id = monitor.id;

                    if (monitor.sendUrl !== undefined) {
                        relationBean.send_url = monitor.sendUrl;
                    }

                    if (monitor.url !== undefined) {
                        relationBean.custom_url = monitor.url;
                    }

                    await R.store(relationBean);
                }

                groupIDList.push(groupBean.id);
                group.id = groupBean.id;
            }

            // Delete groups that are not in the list
            log.debug("socket", "Delete groups that are not in the list");
            if (groupIDList.length === 0) {
                // G4.18: tenant-scoped bulk delete (multi-row by design — all
                // groups of this page)
                await execForTenant("DELETE FROM `group` WHERE status_page_id = ?", [statusPage.id], socket.tenantID, {
                    requireId: false,
                });
            } else {
                const slots = groupIDList.map(() => "?").join(",");

                const data = [...groupIDList, statusPage.id];
                // G4.18: tenant-scoped bulk delete (see above)
                await execForTenant(
                    `DELETE FROM \`group\` WHERE id NOT IN (${slots}) AND status_page_id = ?`,
                    data,
                    socket.tenantID,
                    {
                        requireId: false,
                    }
                );
            }

            const server = UptimeKumaServer.getInstance();

            // Also change entry page to new slug if it is the default one, and slug is changed.
            if (server.entryPage === "statusPage-" + slug && statusPage.slug !== slug) {
                server.entryPage = "statusPage-" + statusPage.slug;
                await Settings.set("entryPage", server.entryPage, "general");
            }

            apicache.clear();

            callback({
                ok: true,
                publicGroupList,
            });
        } catch (error) {
            log.error("socket", error);

            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Add a new status page
    socket.on("addStatusPage", async (title, slug, callback) => {
        try {
            checkLogin(socket);
            // G3 task-14: mutation — creates a status page → STATUS_PAGE_CREATE
            // (tenant_admin, task-13 matrix).
            checkPermission(socket, PERMISSIONS.STATUS_PAGE_CREATE);

            title = title?.trim();
            slug = slug?.trim();

            // Check empty
            if (!title || !slug) {
                throw new Error("Please input all fields");
            }

            // Make sure slug is string
            if (typeof slug !== "string") {
                throw new Error("Slug -Accept string only");
            }

            // lower case only
            slug = slug.toLowerCase();

            checkSlug(slug);

            // G4.18: born into the caller's tenant
            let statusPage = dispenseForTenant("status_page", socket.tenantID);
            statusPage.slug = slug;
            statusPage.title = title;
            statusPage.theme = "auto";
            statusPage.icon = "";
            statusPage.autoRefreshInterval = 300;
            await R.store(statusPage);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                slug: slug,
            });
        } catch (error) {
            log.error("socket", error);
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Delete a status page
    socket.on("deleteStatusPage", async (slug, callback) => {
        const server = UptimeKumaServer.getInstance();

        try {
            checkLogin(socket);
            // G3 task-14: mutation — destructive (drops incidents, groups and
            // the page itself) → STATUS_PAGE_DELETE (tenant_admin).
            checkPermission(socket, PERMISSIONS.STATUS_PAGE_DELETE);

            // G4.18: tenant-scoped slug resolution — a foreign tenant's page is
            // "not found" here
            let statusPage = await getSlugForTenant(socket, slug);

            if (statusPage) {
                const statusPageID = statusPage.id;
                // Reset entry page if it is the default one.
                if (server.entryPage === "statusPage-" + slug) {
                    server.entryPage = "dashboard";
                    await Settings.set("entryPage", server.entryPage, "general");
                }

                // No need to delete records from `status_page_cname`, because it has cascade foreign key.
                // But for incident & group, it is hard to add cascade foreign key during migration, so they have to be deleted manually.

                // Delete incident
                // G4.18: parent-anchored incident rows pinned to the caller's tenant
                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- incident has no tenant_id column (ADR-0002); rows pinned via IN-subquery on status_page.tenant_id
                await R.exec(
                    "DELETE FROM incident WHERE status_page_id = ? " +
                    "AND status_page_id IN (SELECT id FROM status_page WHERE tenant_id = ?) ",
                    [statusPageID, socket.tenantID]
                );

                // Delete group
                // G4.18: tenant-scoped bulk delete (multi-row by design)
                await execForTenant("DELETE FROM `group` WHERE status_page_id = ? ", [statusPageID], socket.tenantID, {
                    requireId: false,
                });

                // Delete status_page
                await execForTenant("DELETE FROM status_page WHERE id = ? ", [statusPageID], socket.tenantID);

                apicache.clear();
            } else {
                throw new Error("Status Page is not found");
            }

            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
};

/**
 * Check slug a-z, 0-9, - only
 * Regex from: https://stackoverflow.com/questions/22454258/js-regex-string-validation-for-slug
 * @param {string} slug Slug to test
 * @returns {void}
 * @throws Slug is not valid
 */
function checkSlug(slug) {
    if (typeof slug !== "string") {
        throw new Error("Slug must be string");
    }

    slug = slug.trim();

    if (!slug) {
        throw new Error("Slug cannot be empty");
    }

    if (!slug.match(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)) {
        throw new Error("Invalid Slug");
    }
}
