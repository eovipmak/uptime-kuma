const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");
// G4.19: tenant-safe query wrappers (G4.17 contract)
const { findAllForTenant, resolveTenantId } = require("../repository/tenant-repo");
// G2 task-11: tenant-partitioned room key for user-scoped emits
const { userRoom } = require("../socket-handlers/tenant-room");
const cheerio = require("cheerio");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const jsesc = require("jsesc");
const analytics = require("../analytics/analytics");
const { marked } = require("marked");
const { Feed } = require("feed");
const config = require("../config");
const dayjs = require("dayjs");

const { setting } = require("../util-server");
const {
    STATUS_PAGE_ALL_DOWN,
    STATUS_PAGE_ALL_UP,
    STATUS_PAGE_MAINTENANCE,
    STATUS_PAGE_PARTIAL_DOWN,
    UP,
    MAINTENANCE,
    DOWN,
    INCIDENT_PAGE_SIZE,
} = require("../../src/util");

class StatusPage extends BeanModel {
    /**
     * Domain → status page mapping, like:
     * { "test-uptime.kuma.pet": { tenantId: 1, slug: "default" } }
     * Built by loadDomainMappingList() (G6.24 tenant-aware shape).
     * @type {{}}
     */
    static domainMappingList = {};

    /**
     * Handle responses to RSS pages
     * @param {Response} response Response object
     * @param {string} slug Status page slug
     * @param {Request} request Request object
     * @param {number} tenantId Tenant the page must belong to (G6.24, resolved
     * by resolveStatusPageTenant middleware)
     * @returns {Promise<void>}
     */
    static async handleStatusPageRSSResponse(response, slug, request, tenantId) {
        let statusPage = await R.findOne("status_page", " slug = ? AND tenant_id = ? ", [slug, tenantId]);

        if (statusPage && Number(statusPage.tenant_id) !== Number(tenantId)) {
            // Belt-and-braces: never render a page outside the resolved tenant.
            statusPage = null;
        }

        if (statusPage) {
            const feedUrl = await StatusPage.buildRSSUrl(slug, request, tenantId);
            response.type("application/rss+xml");
            response.send(await StatusPage.renderRSS(statusPage, feedUrl));
        } else {
            response.status(404).send(UptimeKumaServer.getInstance().indexHTML);
        }
    }

    /**
     * Handle responses to status page
     * @param {Response} response Response object
     * @param {string} indexHTML HTML to render
     * @param {string} slug Status page slug
     * @param {number} tenantId Tenant the page must belong to (G6.24, resolved
     * by resolveStatusPageTenant middleware)
     * @returns {Promise<void>}
     */
    static async handleStatusPageResponse(response, indexHTML, slug, tenantId) {
        // Handle url with trailing slash (http://localhost:3001/status/)
        // The slug comes from the route "/status/:slug". If the slug is empty, express converts it to "index.html"
        if (slug === "index.html") {
            slug = "default";
        }

        let statusPage = await R.findOne("status_page", " slug = ? AND tenant_id = ? ", [slug, tenantId]);

        if (statusPage && Number(statusPage.tenant_id) !== Number(tenantId)) {
            // Belt-and-braces: never render a page outside the resolved tenant.
            statusPage = null;
        }

        if (statusPage) {
            response.send(await StatusPage.renderHTML(indexHTML, statusPage, tenantId));
        } else {
            response.status(404).send(UptimeKumaServer.getInstance().indexHTML);
        }
    }

    /**
     * SSR for RSS feed
     * @param {StatusPage} statusPage Status page object
     * @param {string} feedUrl The URL for the RSS feed
     * @returns {Promise<string>} The rendered RSS XML
     */
    static async renderRSS(statusPage, feedUrl) {
        const { incidents, heartbeats, statusDescription } = await StatusPage.getRSSPageData(statusPage);

        // Use custom RSS title if set, otherwise fall back to status page title
        let feedTitle = "Uptime Kuma RSS Feed";
        if (statusPage.rss_title) {
            feedTitle = statusPage.rss_title;
        } else if (statusPage.title) {
            feedTitle = `${statusPage.title} RSS Feed`;
        }

        const feed = new Feed({
            title: feedTitle,
            description: `Current status: ${statusDescription}`,
            link: feedUrl,
            language: "en", // optional, used only in RSS 2.0, possible values: http://www.w3.org/TR/REC-html40/struct/dirlang.html#langcodes
            updated: new Date(), // optional, default = today
        });

        incidents.forEach((incident) => {
            let lastUpdatedDate = incident.lastUpdatedDate || incident.createdDate;
            feed.addItem({
                title: incident.title,
                description: incident.content,
                id: `i${incident.id}-${lastUpdatedDate}`,
                link: feedUrl,
                date: dayjs.utc(lastUpdatedDate).toDate(),
            });
        });

        heartbeats.forEach((heartbeat) => {
            feed.addItem({
                title: `${heartbeat.name} is down`,
                description: `${heartbeat.name} has been down since ${heartbeat.time} UTC`,
                id: `${heartbeat.monitorID}-${heartbeat.time}`,
                link: feedUrl,
                date: dayjs.utc(heartbeat.time).toDate(),
            });
        });

        return feed.rss2();
    }

    /**
     * Build RSS feed URL, handling proxy headers
     * @param {string} slug Status page slug
     * @param {Request} request Express request object
     * @param {number} tenantId Tenant owning the page (G6.24; reserved for
     * task-25 tenant-aware feed branding/links — not used yet)
     * @returns {Promise<string>} The full URL for the RSS feed
     */
    static async buildRSSUrl(slug, request, tenantId = null) {
        if (request) {
            const trustProxy = await setting("trustProxy");

            // Determine protocol (check X-Forwarded-Proto if behind proxy)
            let proto = request.protocol;
            if (trustProxy && request.headers["x-forwarded-proto"]) {
                proto = request.headers["x-forwarded-proto"].split(",")[0].trim();
            }

            // Determine host (check X-Forwarded-Host if behind proxy)
            let host = request.get("host");
            if (trustProxy && request.headers["x-forwarded-host"]) {
                host = request.headers["x-forwarded-host"];
            }

            return `${proto}://${host}/status/${slug}`;
        }

        // Fallback to config values
        const proto = config.isSSL ? "https" : "http";
        const host = config.hostname || "localhost";
        const port = config.port;
        return `${proto}://${host}:${port}/status/${slug}`;
    }

    /**
     * SSR for status pages
     * @param {string} indexHTML HTML page to render
     * @param {StatusPage} statusPage Status page populate HTML with
     * @param {number} tenantId Tenant owning the page (G6.24; reserved for
     * task-25 tenant-specific branding injection — not used yet)
     * @returns {Promise<string>} the rendered html
     */
    static async renderHTML(indexHTML, statusPage, tenantId = null) {
        void tenantId; // G6.24 passes it through; task-25 injects tenant branding.
        const $ = cheerio.load(indexHTML);

        const description155 = marked(statusPage.description ?? "")
            .replace(/<[^>]+>/gm, "")
            .trim()
            .substring(0, 155);

        $("title").text(statusPage.title);
        $("meta[name=description]").attr("content", description155);

        if (statusPage.icon) {
            $("link[rel=icon]").attr("href", statusPage.icon).removeAttr("type");

            $("link[rel=apple-touch-icon]").remove();
        }

        const head = $("head");

        if (analytics.isValidAnalyticsConfig(statusPage)) {
            let escapedAnalyticsScript = analytics.getAnalyticsScript(statusPage);
            head.append($(escapedAnalyticsScript));
        }

        // OG Meta Tags
        let ogTitle = $('<meta property="og:title" content="" />').attr("content", statusPage.title);
        head.append(ogTitle);

        let ogDescription = $('<meta property="og:description" content="" />').attr("content", description155);
        head.append(ogDescription);

        let ogType = $('<meta property="og:type" content="website" />');
        head.append(ogType);

        // Preload data
        // Add jsesc, fix https://github.com/louislam/uptime-kuma/issues/2186
        const escapedJSONObject = jsesc(await StatusPage.getStatusPageData(statusPage), {
            isScriptContext: true,
        });

        const script = $(`
            <script id="preload-data" data-json="{}">
                window.preloadData = ${escapedJSONObject};
            </script>
        `);

        head.append(script);

        // manifest.json
        $("link[rel=manifest]").attr("href", `/api/status-page/${statusPage.slug}/manifest.json`);

        return $.root().html();
    }

    /**
     * @param {heartbeats} heartbeats from getRSSPageData
     * @returns {number} status_page constant from util.ts
     */
    static overallStatus(heartbeats) {
        if (heartbeats.length === 0) {
            return -1;
        }

        let status = STATUS_PAGE_ALL_UP;
        let hasUp = false;

        for (let beat of heartbeats) {
            if (beat.status === MAINTENANCE) {
                return STATUS_PAGE_MAINTENANCE;
            } else if (beat.status === UP) {
                hasUp = true;
            } else {
                status = STATUS_PAGE_PARTIAL_DOWN;
            }
        }

        if (!hasUp) {
            status = STATUS_PAGE_ALL_DOWN;
        }

        return status;
    }

    /**
     * @param {number} status from overallStatus
     * @returns {string} description
     */
    static getStatusDescription(status) {
        if (status === -1) {
            return "No Services";
        }

        if (status === STATUS_PAGE_ALL_UP) {
            return "All Systems Operational";
        }

        if (status === STATUS_PAGE_PARTIAL_DOWN) {
            return "Partially Degraded Service";
        }

        if (status === STATUS_PAGE_ALL_DOWN) {
            return "Degraded Service";
        }

        // TODO: show the real maintenance information: title, description, time
        if (status === MAINTENANCE) {
            return "Under maintenance";
        }

        return "?";
    }

    /**
     * Get all data required for RSS
     * @param {StatusPage} statusPage Status page to get data for
     * @returns {object} Status page data
     */
    static async getRSSPageData(statusPage) {
        const { incidents, publicGroupList } = await StatusPage.getStatusPageData(statusPage);

        let heartbeats = [];

        for (let monitorGroup of publicGroupList) {
            for (const monitor of monitorGroup.monitorList) {
                // eslint-disable-next-line uptime-kuma/require-tenant-scope -- heartbeat is FK-anchored to monitor; the monitor list comes from a tenant-resolved status page bean
                const heartbeat = await R.findOne("heartbeat", "monitor_id = ? ORDER BY time DESC", [monitor.id]);
                if (heartbeat) {
                    heartbeats.push({
                        ...monitor,
                        status: heartbeat.status,
                        time: heartbeat.time,
                    });
                }
            }
        }

        // calculate RSS feed description
        let status = StatusPage.overallStatus(heartbeats);
        let statusDescription = StatusPage.getStatusDescription(status);

        // keep only DOWN heartbeats in the RSS feed
        const downHeartbeats = heartbeats.filter((heartbeat) => heartbeat.status === DOWN);

        return {
            incidents,
            heartbeats: downHeartbeats,
            statusDescription,
        };
    }

    /**
     * Get all status page data in one call
     * @param {StatusPage} statusPage Status page to get data for
     * @returns {object} Status page data
     */
    static async getStatusPageData(statusPage) {
        const config = await statusPage.toPublicJSON();

        // All active incidents
        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- incident is FK-anchored to status_page (no tenant_id column by G1 design); statusPage bean is tenant-resolved upstream
        let incidents = await R.find(
            "incident",
            "pin = 1 AND active = 1 AND status_page_id = ? ORDER BY created_date DESC",
            [statusPage.id]
        );
        incidents = incidents.map((i) => i.toPublicJSON());

        let maintenanceList = await StatusPage.getMaintenanceList(statusPage.id);

        // Public Group List
        const publicGroupList = [];
        const showTags = !!statusPage.show_tags;

        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- group rows are FK-anchored to this tenant-resolved status page (status_page_id)
        const list = await R.find("group", "public = 1 AND status_page_id = ? ORDER BY weight", [statusPage.id]);

        for (let groupBean of list) {
            let monitorGroup = await groupBean.toPublicJSON(showTags, config?.showCertificateExpiry);
            publicGroupList.push(monitorGroup);
        }

        // Response
        return {
            config,
            incidents,
            publicGroupList,
            maintenanceList,
        };
    }

    /**
     * Loads domain mapping from DB (G6.24 tenant-aware shape).
     * Return object like this: { "test-uptime.kuma.pet": { tenantId: 1, slug: "default" } }
     * Only PUBLISHED pages are mapped — public custom-domain routing never
     * serves drafts.
     * @returns {Promise<void>}
     */
    static async loadDomainMappingList() {
        const rows = await R.getAll(`
            SELECT spc.domain, sp.slug, sp.tenant_id
            FROM status_page_cname spc
            JOIN status_page sp ON sp.id = spc.status_page_id
            WHERE sp.published = 1
        `);
        StatusPage.domainMappingList = {};
        for (const row of rows) {
            StatusPage.domainMappingList[row.domain] = {
                tenantId: Number(row.tenant_id),
                slug: row.slug,
            };
        }
    }

    /**
     * Send status page list to client
     * @param {Server} io io Socket server instance
     * @param {Socket} socket Socket.io instance
     * @returns {Promise<Bean[]>} Status page list (this tenant's pages only, G4.19)
     */
    static async sendStatusPageList(io, socket) {
        let result = {};

        // G4.19: was a global findAll across every tenant; now scoped so
        // tenant A never receives tenant B's status pages.
        const scopedTenantId = await resolveTenantId(socket.tenantID, "StatusPage.sendStatusPageList");
        let list = await findAllForTenant("status_page", " 1=1 ", [], scopedTenantId, " ORDER BY title ");

        for (let item of list) {
            result[item.id] = await item.toJSON();
        }

        io.to(userRoom(socket.tenantID, socket.userID)).emit("statusPageList", result);
        return list;
    }

    /**
     * Update list of domain names
     * @param {string[]} domainNameList List of status page domains
     * @returns {Promise<void>}
     */
    async updateDomainNameList(domainNameList) {
        if (!Array.isArray(domainNameList)) {
            throw new Error("Invalid array");
        }

        let trx = await R.begin();

        await trx.exec("DELETE FROM status_page_cname WHERE status_page_id = ?", [this.id]);

        try {
            for (let domain of domainNameList) {
                if (typeof domain !== "string") {
                    throw new Error("Invalid domain");
                }

                if (domain.trim() === "") {
                    continue;
                }

                // If the domain name is used in another status page, delete it
                await trx.exec("DELETE FROM status_page_cname WHERE domain = ?", [domain]);

                let mapping = trx.dispense("status_page_cname");
                mapping.status_page_id = this.id;
                mapping.domain = domain;
                await trx.store(mapping);
            }
            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }
    }

    /**
     * Get list of domain names
     * @returns {object[]} List of status page domains
     */
    getDomainNameList() {
        let domainList = [];
        for (let domain in StatusPage.domainMappingList) {
            // G6.24 shape: { tenantId, slug } — a mapping belongs to this page
            // only when BOTH the slug and the owning tenant match, so tenant A's
            // editor never sees tenant B's domains for an identically named page.
            let s = StatusPage.domainMappingList[domain];

            if (s && s.slug === this.slug && Number(s.tenantId) === Number(this.tenant_id)) {
                domainList.push(domain);
            }
        }
        return domainList;
    }

    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    async toJSON() {
        return {
            id: this.id,
            slug: this.slug,
            title: this.title,
            description: this.description,
            icon: this.getIcon(),
            theme: this.theme,
            autoRefreshInterval: this.autoRefreshInterval,
            published: !!this.published,
            showTags: !!this.show_tags,
            domainNameList: this.getDomainNameList(),
            customCSS: this.custom_css,
            footerText: this.footer_text,
            showPoweredBy: !!this.show_powered_by,
            analyticsId: this.analytics_id,
            analyticsScriptUrl: this.analytics_script_url,
            analyticsType: this.analytics_type,
            showCertificateExpiry: !!this.show_certificate_expiry,
            showOnlyLastHeartbeat: !!this.show_only_last_heartbeat,
            rssTitle: this.rss_title,
        };
    }

    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @returns {object} Object ready to parse
     */
    async toPublicJSON() {
        return {
            slug: this.slug,
            title: this.title,
            description: this.description,
            icon: this.getIcon(),
            autoRefreshInterval: this.autoRefreshInterval,
            theme: this.theme,
            published: !!this.published,
            showTags: !!this.show_tags,
            customCSS: this.custom_css,
            footerText: this.footer_text,
            showPoweredBy: !!this.show_powered_by,
            analyticsId: this.analytics_id,
            analyticsScriptUrl: this.analytics_script_url,
            analyticsType: this.analytics_type,
            showCertificateExpiry: !!this.show_certificate_expiry,
            showOnlyLastHeartbeat: !!this.show_only_last_heartbeat,
            rssTitle: this.rss_title,
        };
    }

    /**
     * Convert slug to status page ID
     * @param {string} slug Status page slug
     * @returns {Promise<number>} ID of status page
     */
    static async slugToID(slug) {
        return await R.getCell("SELECT id FROM status_page WHERE slug = ? ", [slug]);
    }

    /**
     * Get path to the icon for the page
     * @returns {string} Path
     */
    getIcon() {
        if (!this.icon) {
            return "/icon.svg";
        } else {
            return this.icon;
        }
    }

    /**
     * Get paginated incident history for a status page using cursor-based pagination
     * @param {number} statusPageId ID of the status page
     * @param {string|null} cursor ISO date string cursor (created_date of last item from previous page)
     * @param {boolean} isPublic Whether to return public or admin data
     * @returns {Promise<object>} Paginated incident data with cursor
     */
    static async getIncidentHistory(statusPageId, cursor = null, isPublic = true) {
        let incidents;

        if (cursor) {
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- incident is FK-anchored to status_page; statusPageId comes from an authenticated socket or a hostname-resolved public page
            incidents = await R.find(
                "incident",
                " status_page_id = ? AND created_date < ? ORDER BY created_date DESC LIMIT ? ",
                [statusPageId, cursor, INCIDENT_PAGE_SIZE]
            );
        } else {
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- incident is FK-anchored to status_page; statusPageId comes from an authenticated socket or a hostname-resolved public page
            incidents = await R.find("incident", " status_page_id = ? ORDER BY created_date DESC LIMIT ? ", [
                statusPageId,
                INCIDENT_PAGE_SIZE,
            ]);
        }

        const total = await R.count("incident", " status_page_id = ? ", [statusPageId]);

        const lastIncident = incidents[incidents.length - 1];
        let nextCursor = null;
        let hasMore = false;

        if (lastIncident) {
            const moreCount = await R.count("incident", " status_page_id = ? AND created_date < ? ", [
                statusPageId,
                lastIncident.created_date,
            ]);
            hasMore = moreCount > 0;
            if (hasMore) {
                nextCursor = lastIncident.created_date;
            }
        }

        return {
            incidents: incidents.map((i) => i.toPublicJSON()),
            total,
            nextCursor,
            hasMore,
        };
    }

    /**
     * Get list of maintenances
     * @param {number} statusPageId ID of status page to get maintenance for
     * @returns {object} Object representing maintenances sanitized for public
     */
    static async getMaintenanceList(statusPageId) {
        try {
            const publicMaintenanceList = [];

            let maintenanceIDList = await R.getCol(
                `
                SELECT DISTINCT maintenance_id
                FROM maintenance_status_page
                WHERE status_page_id = ?
            `,
                [statusPageId]
            );

            for (const maintenanceID of maintenanceIDList) {
                let maintenance = UptimeKumaServer.getInstance().getMaintenance(maintenanceID);
                if (maintenance && (await maintenance.isUnderMaintenance())) {
                    publicMaintenanceList.push(await maintenance.toPublicJSON());
                }
            }

            return publicMaintenanceList;
        } catch (error) {
            return [];
        }
    }

    /**
     * Tenant this status page belongs to (G1 multi-tenant model)
     * @returns {number|null} tenant_id column value
     */
    get tenantId() {
        return this.tenant_id;
    }

    /**
     * List all status pages belonging to a tenant
     * @param {number} tenantId ID of the tenant
     * @returns {Promise<object[]>} List of status page rows ordered by id
     */
    static async listForTenant(tenantId) {
        return await R.getAll("SELECT * FROM status_page WHERE tenant_id = ? ORDER BY id", [tenantId]);
    }
}

module.exports = StatusPage;
