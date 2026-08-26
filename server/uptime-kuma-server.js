const express = require("express");
const https = require("https");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const { R } = require("redbean-node");
const { log, isDev } = require("../src/util");
const Database = require("./database");
const util = require("util");
const { Settings } = require("./settings");
const TenantUser = require("./model/tenant_user");
const dayjs = require("dayjs");
const childProcessAsync = require("promisify-child-process");
const path = require("path");
const axios = require("axios");
const { isSSL, sslKey, sslCert, sslKeyPassphrase } = require("./config");
// G2 task-11: tenant-partitioned room keys for user-scoped emits
const { userRoom } = require("./socket-handlers/tenant-room");
// G2 task-12: force-logout watchdog for users removed from their tenant
const {
    startTenantMembershipCheckJob,
    stopTenantMembershipCheckJob,
} = require("./jobs/check-tenant-membership");
// G4.19: tenant-safe query wrappers (G4.17 contract)
const { findForTenant, findAllForTenant, resolveTenantId } = require("./repository/tenant-repo");
// DO NOT IMPORT HERE IF THE MODULES USED `UptimeKumaServer.getInstance()`, put at the bottom of this file instead.

/**
 * `module.exports` (alias: `server`) should be inside this class, in order to avoid circular dependency issue.
 * @type {UptimeKumaServer}
 */
class UptimeKumaServer {
    /**
     * Current server instance
     * @type {UptimeKumaServer}
     */
    static instance = null;

    /**
     * G5.21 (kanban task-21): the canonical in-memory engine map, partitioned
     * by tenant. Shape: monitorListByTenant[tenantId][monitorID] = Monitor.
     * Written by startMonitors()/startMonitor()/pauseMonitor() and read by
     * shutdownFunction(); tasks G5.22/G5.23 consume this structure. The
     * legacy flat `monitorList` property is a @deprecated getter below that
     * returns the default tenant's bucket for backward compatibility with
     * single-tenant code paths that have not been migrated yet.
     * @type {{[tenantId: number]: {[monitorID: number]: object}}}
     */
    monitorListByTenant = {};

    /**
     * Resolved id of the seeded default tenant (slug "default"). Populated in
     * initAfterDatabaseReady() and used only by the deprecated
     * `monitorList` compat getter. null until resolved, which makes the
     * getter return an empty object — safe at boot time when nothing has been
     * loaded yet anyway.
     * @type {number|null}
     */
    defaultTenantId = null;

    /**
     * G4.19/G5.21: tenant-partitioned maintenance map. Shape:
     * maintenanceListByTenant[tenantId][maintenanceId] = bean. Filled by
     * loadMaintenanceList(); consumed by getMaintenanceJSONList and
     * getMaintenanceForTenant so emits never leak across tenants.
     * @type {{[tenantId: number]: {[maintenanceId: number]: object}}}
     */
    maintenanceListByTenant = {};

    /**
     * Legacy flat monitor list. @deprecated since G5.21 (kanban task-21):
     * returns the DEFAULT tenant's bucket of monitorListByTenant so code not
     * yet migrated keeps working on single-tenant installs. Never use in new
     * code — index monitorListByTenant[tenantId] instead. Note this getter
     * must stay read-only for the map shape itself: callers may mutate the
     * returned bucket (legacy write pattern), but per-tenant writes belong to
     * the partitioned structure.
     * @returns {{[monitorID: number]: object}} default tenant bucket
     */
    get monitorList() {
        return this.monitorListByTenant[this.defaultTenantId] || {};
    }

    /**
     * Legacy flat maintenance list.
     * @deprecated since G5.21 (kanban task-21): maintenanceListByTenant below
     * is the canonical map. This flat index is deliberately kept as a GLOBAL
     * registry (not a per-tenant bucket view) for two reasons:
     *  1. Engine consumers keyed by maintenanceID alone still resolve through
     *     it (getMaintenance): Monitor.isUnderMaintenance (beat + push
     *     router) and public status-page maintenance display have no tenant
     *     context until G5.22 owns dispatch migration. Maintenance ids are
     *     globally unique PKs, so this read cannot cross tenants.
     *  2. The maintenance socket handler registers runtime-created beans via
     *     `server.maintenanceList[id] = bean`. Redirecting that write into a
     *     default-tenant bucket view would leak other tenants' rows into the
     *     default tenant's emits.
     * New code MUST use getMaintenanceForTenant(maintenanceID, tenantID).
     * Full retirement of this index is owned by G5.22/G5.23.
     * @type {{}}
     */
    maintenanceList = {};

    entryPage = "dashboard";
    app = undefined;
    httpServer = undefined;
    io = undefined;

    /**
     * Cache Index HTML
     * @type {string}
     */
    indexHTML = "";

    /**
     * @type {{}}
     */
    static monitorTypeList = {};

    /**
     * G2 task-12: token of the running tenant-membership check job
     * (null when the job is not running).
     * @type {object|null}
     */
    tenantCheckToken = null;

    /**
     * Use for decode the auth object
     * @type {null}
     */
    jwtSecret = null;

    /**
     * Get the current instance of the server if it exists, otherwise
     * create a new instance.
     * @returns {UptimeKumaServer} Server instance
     */
    static getInstance() {
        if (UptimeKumaServer.instance == null) {
            UptimeKumaServer.instance = new UptimeKumaServer();
        }
        return UptimeKumaServer.instance;
    }

    /**
     *
     */
    constructor() {
        // Set axios default user-agent to Uptime-Kuma/version
        axios.defaults.headers.common["User-Agent"] = this.getUserAgent();

        // Set default axios timeout to 5 minutes instead of infinity
        axios.defaults.timeout = 300 * 1000;

        log.info("server", "Creating express and socket.io instance");
        this.app = express();
        if (isSSL) {
            log.info("server", "Server Type: HTTPS");
            this.httpServer = https.createServer(
                {
                    key: fs.readFileSync(sslKey),
                    cert: fs.readFileSync(sslCert),
                    passphrase: sslKeyPassphrase,
                },
                this.app
            );
        } else {
            log.info("server", "Server Type: HTTP");
            this.httpServer = http.createServer(this.app);
        }

        try {
            this.indexHTML = fs.readFileSync("./dist/index.html").toString();
        } catch (e) {
            // "dist/index.html" is not necessary for development
            if (process.env.NODE_ENV !== "development") {
                log.error("server", "Error: Cannot find 'dist/index.html', did you install correctly?");
                process.exit(1);
            }
        }

        // Set Monitor Types
        UptimeKumaServer.monitorTypeList["real-browser"] = new RealBrowserMonitorType();
        UptimeKumaServer.monitorTypeList["tailscale-ping"] = new TailscalePing();
        UptimeKumaServer.monitorTypeList["websocket-upgrade"] = new WebSocketMonitorType();
        UptimeKumaServer.monitorTypeList["dns"] = new DnsMonitorType();
        UptimeKumaServer.monitorTypeList["postgres"] = new PostgresMonitorType();
        UptimeKumaServer.monitorTypeList["mqtt"] = new MqttMonitorType();
        UptimeKumaServer.monitorTypeList["smtp"] = new SMTPMonitorType();
        UptimeKumaServer.monitorTypeList["group"] = new GroupMonitorType();
        UptimeKumaServer.monitorTypeList["snmp"] = new SNMPMonitorType();
        UptimeKumaServer.monitorTypeList["grpc-keyword"] = new GrpcKeywordMonitorType();
        UptimeKumaServer.monitorTypeList["mongodb"] = new MongodbMonitorType();
        UptimeKumaServer.monitorTypeList["rabbitmq"] = new RabbitMqMonitorType();
        UptimeKumaServer.monitorTypeList["sip-options"] = new SIPMonitorType();
        UptimeKumaServer.monitorTypeList["gamedig"] = new GameDigMonitorType();
        UptimeKumaServer.monitorTypeList["steam"] = new SteamMonitorType();
        UptimeKumaServer.monitorTypeList["port"] = new TCPMonitorType();
        UptimeKumaServer.monitorTypeList["manual"] = new ManualMonitorType();
        UptimeKumaServer.monitorTypeList["globalping"] = new GlobalpingMonitorType(this.getUserAgent());
        UptimeKumaServer.monitorTypeList["redis"] = new RedisMonitorType();
        UptimeKumaServer.monitorTypeList["pm2"] = new PM2MonitorType();
        UptimeKumaServer.monitorTypeList["system-service"] = new SystemServiceMonitorType();
        UptimeKumaServer.monitorTypeList["sqlserver"] = new MssqlMonitorType();
        UptimeKumaServer.monitorTypeList["mysql"] = new MysqlMonitorType();
        UptimeKumaServer.monitorTypeList["oracledb"] = new OracleDbMonitorType();
        UptimeKumaServer.monitorTypeList["ntp"] = new NTPMonitorType();

        // Allow all CORS origins (polling) in development
        let cors = undefined;
        if (isDev) {
            cors = {
                origin: "*",
            };
        }

        this.io = new Server(this.httpServer, {
            cors,
            allowRequest: async (req, callback) => {
                let transport;
                // It should be always true, but just in case, because this property is not documented
                if (req._query) {
                    transport = req._query.transport;
                } else {
                    log.error("socket", "Ops!!! Cannot get transport type, assume that it is polling");
                    transport = "polling";
                }

                const clientIP = await this.getClientIPwithProxy(req.connection.remoteAddress, req.headers);
                log.info("socket", `New ${transport} connection, IP = ${clientIP}`);

                // The following check is only for websocket connections, polling connections are already protected by CORS
                if (transport === "polling") {
                    callback(null, true);
                } else if (transport === "websocket") {
                    const bypass = process.env.UPTIME_KUMA_WS_ORIGIN_CHECK === "bypass";
                    if (bypass) {
                        log.info("auth", "WebSocket origin check is bypassed");
                        callback(null, true);
                    } else if (!req.headers.origin) {
                        log.info("auth", "WebSocket with no origin is allowed");
                        callback(null, true);
                    } else {
                        let host = req.headers.host;
                        let origin = req.headers.origin;

                        try {
                            let originURL = new URL(origin);
                            let xForwardedFor;
                            if (await Settings.get("trustProxy")) {
                                xForwardedFor = req.headers["x-forwarded-for"];
                            }

                            if (host !== originURL.host && xForwardedFor !== originURL.host) {
                                callback(null, false);
                                log.error("auth", `Origin (${origin}) does not match host (${host}), IP: ${clientIP}`);
                            } else {
                                callback(null, true);
                            }
                        } catch (e) {
                            // Invalid origin url, probably not from browser
                            callback(null, false);
                            log.error("auth", `Invalid origin url (${origin}), IP: ${clientIP}`);
                        }
                    }
                }
            },
        });
    }

    /**
     * Initialise app after the database has been set up
     * @returns {Promise<void>}
     */
    async initAfterDatabaseReady() {
        // Static
        this.app.use("/screenshots", express.static(Database.screenshotDir));

        process.env.TZ = await this.getTimezone();
        dayjs.tz.setDefault(process.env.TZ);
        log.debug("DEBUG", "Timezone: " + process.env.TZ);
        log.debug("DEBUG", "Current Time: " + dayjs.tz().format());

        // G5.21 (kanban task-21): resolve the seeded default tenant's numeric
        // id once for the deprecated `monitorList` compat getter. Kept in
        // sync with DEFAULT_TENANT_SLUG in server/repository/tenant-repo.js
        // (duplicated literal, same reason: avoid widening the import graph).
        // A missing default tenant is not fatal — the engine is fully
        // partitioned — but the legacy getter will return an empty bucket,
        // which is announced loudly.
        try {
            // eslint-disable-next-line uptime-kuma/require-tenant-scope -- the tenant registry itself is global by definition (slug lookup, partition discovery)
            const defaultTenant = await R.findOne("tenant", " slug = ? ", [ "default" ]);
            this.defaultTenantId = defaultTenant ? defaultTenant.id : null;
            if (this.defaultTenantId == null) {
                log.warn("server", "initAfterDatabaseReady: no 'default' tenant found; legacy monitorList compat getter returns an empty bucket");
            }
        } catch (e) {
            log.error("server", `initAfterDatabaseReady: failed to resolve default tenant id: ${e.message}`);
        }

        await this.loadMaintenanceList();

        // G2 task-12: start the tenant-membership watchdog (force-logout on
        // removal). Idempotent; ticks are fail-open and tolerate io not being
        // attached yet. Wrapped so a job failure never blocks server startup.
        try {
            this.tenantCheckToken = startTenantMembershipCheckJob(this);
        } catch (e) {
            log.error("server", `Failed to start tenant membership check job: ${e.message}`);
        }
    }

    /**
     * Send list of monitors to client
     * @param {Socket} socket Socket to send list on
     * @returns {Promise<object>} List of monitors
     */
    async sendMonitorList(socket) {
        let list = await this.getMonitorJSONList(await resolveTenantId(socket.tenantID, "sendMonitorList"), socket.userID);
        this.io.to(userRoom(socket.tenantID, socket.userID)).emit("monitorList", list);
        return list;
    }

    /**
     * Update Monitor into list
     * @param {Socket} socket Socket to send list on
     * @param {number} monitorID update or deleted monitor id
     * @returns {Promise<void>}
     */
    async sendUpdateMonitorIntoList(socket, monitorID) {
        let list = await this.getMonitorJSONList(
            await resolveTenantId(socket.tenantID, "sendUpdateMonitorIntoList"),
            socket.userID,
            monitorID
        );
        if (list && list[monitorID]) {
            this.io.to(userRoom(socket.tenantID, socket.userID)).emit("updateMonitorIntoList", list);
        }
    }

    /**
     * Delete Monitor from list
     * @param {Socket} socket Socket to send list on
     * @param {number} monitorID update or deleted monitor id
     * @returns {Promise<void>}
     */
    async sendDeleteMonitorFromList(socket, monitorID) {
        this.io.to(userRoom(socket.tenantID, socket.userID)).emit("deleteMonitorFromList", monitorID);
    }

    /**
     * Get a list of monitors for the given user (G4.19 contract signature:
     * tenant first, per kanban task-19 acceptance criteria).
     * @param {number} tenantID Active tenant scoping the list. Only monitors
     * of that tenant are returned (strict equality, matching
     * Monitor.listForTenantAndUser; NULL-tenant legacy rows are excluded by
     * design). Resolve via resolveTenantId() when the caller predates tenant
     * threading.
     * @param {string} userID - The ID of the user to get monitors for.
     * @param {number} monitorID - The ID of monitor for.
     * @returns {Promise<object>} A promise that resolves to an object with monitor IDs as keys and monitor objects as values.
     */
    async getMonitorJSONList(tenantID, userID, monitorID = null) {
        // Tenant filter is injected by the wrapper — never hand-written here.
        const tenantScopedQuery = monitorID ? " id = ? AND user_id = ? " : " user_id = ? ";
        const tenantScopedParams = monitorID ? [monitorID, userID] : [userID];
        let tenantMonitorBeans = await findForTenant(
            "monitor",
            tenantScopedQuery,
            tenantScopedParams,
            tenantID,
            "ORDER BY weight DESC, name"
        );

        const monitorData = tenantMonitorBeans.map((monitor) => ({
            id: monitor.id,
            active: monitor.active,
            name: monitor.name,
        }));
        const preloadData = await Monitor.preparePreloadData(monitorData);

        const result = {};
        tenantMonitorBeans.forEach((monitor) => (result[monitor.id] = monitor.toJSON(preloadData)));
        return result;
    }

    /**
     * Send maintenance list to client
     * @param {Socket} socket Socket.io instance to send to
     * @returns {Promise<object>} Maintenance list
     */
    async sendMaintenanceList(socket) {
        return await this.sendMaintenanceListByUserID(socket.userID, socket.tenantID);
    }

    /**
     * Send list of maintenances to user
     * @param {number} userID User to send list to
     * @param {number|null} tenantID Active tenant of the user (G2 task-11).
     * When omitted, falls back to the user's primary tenant so legacy
     * model-layer callers keep delivering until G5 owns dispatch. The emitted
     * list contains only the resolved tenant's maintenances (G4.19).
     * @returns {Promise<object>} Maintenance list
     */
    async sendMaintenanceListByUserID(userID, tenantID = null) {
        const roomTenantID = (tenantID !== null && tenantID !== undefined) ? tenantID : await TenantUser.getPrimaryTenantID(userID);
        if (!roomTenantID) {
            log.warn("maintenance", `sendMaintenanceListByUserID: user ${userID} has no tenant membership; skipping emit`);
            return {};
        }

        let list = await this.getMaintenanceJSONList(roomTenantID);

        this.io.to(userRoom(roomTenantID, userID)).emit("maintenanceList", list);
        return list;
    }

    /**
     * Get a list of maintenances for the given user's tenant.
     * @param {number} tenantID Active tenant of the user (G4.19). Only the
     * tenant-partitioned in-memory map is read, so a tenant never receives
     * another tenant's maintenance entries.
     * @returns {Promise<object>} A promise that resolves to an object with maintenance IDs as keys and maintenances objects as values.
     */
    async getMaintenanceJSONList(tenantID) {
        let result = {};
        const tenantList = this.maintenanceListByTenant[tenantID] || {};
        for (let maintenanceID in tenantList) {
            result[maintenanceID] = await tenantList[maintenanceID].toJSON();
        }
        return result;
    }

    /**
     * Load the maintenance lists and run them (G5.21: partitioned by tenant).
     *
     * Storage shape (the G4.19 contract, now canonical):
     * `this.maintenanceListByTenant[tenantId]` holds that tenant's beans so
     * emits never leak across tenants. The deprecated flat `maintenanceList`
     * index is still filled here as a global registry for engine consumers
     * keyed by maintenanceID alone (see the field's JSDoc for why it must not
     * become a bucket view). Retirement is owned by G5.22/G5.23.
     * Enumerating DISTINCT tenant_id is meta-level partition discovery, not a
     * row read, so it is exempt from the wrapper by design.
     * @returns {Promise<void>}
     */
    async loadMaintenanceList() {
        // eslint-disable-next-line uptime-kuma/require-tenant-scope -- R.getAll is out of the rule's scope anyway; DISTINCT tenant enumeration is partition discovery, not row access
        const tenantRows = await R.getAll("SELECT DISTINCT tenant_id FROM maintenance WHERE tenant_id IS NOT NULL");

        for (const row of tenantRows) {
            const tenantId = row.tenant_id;
            const maintenanceList = await findAllForTenant("maintenance", " 1=1 ", [], tenantId, "ORDER BY end_date DESC, title");

            this.maintenanceListByTenant[tenantId] = {};
            for (let maintenance of maintenanceList) {
                this.maintenanceListByTenant[tenantId][maintenance.id] = maintenance;
                this.maintenanceList[maintenance.id] = maintenance;
                maintenance.run(this);
            }
        }
    }

    /**
     * Retrieve a specific maintenance
     * (G5.21 kanban task-21 frozen signature: tenant first).
     *
     * Canonical form — `getMaintenance(tenantId, maintenanceID)` — reads only
     * the tenant-partitioned map, so a caller holding a tenant-scoped bean
     * (Monitor.isUnderMaintenance in the beat loop) can never resolve a
     * maintenance of another tenant.
     *
     * Legacy tolerance (documented pattern of resolveTenantId): when called
     * with a single argument — engine consumers that have no tenant context
     * yet (public status-page display, push router) — the argument is treated
     * as the maintenanceID and the lookup degrades to the deprecated global
     * registry (see the maintenanceList field's JSDoc for why it stays a
     * global index rather than a default-tenant bucket view). Maintenance ids
     * are globally unique PKs, so this fallback cannot cross tenants for a
     * given id; it is NOT access-controlled, which is why the two-arg form is
     * frozen for all socket-facing code (G5.22/G5.23 own full retirement).
     * @param {number} tenantId Active tenant scoping the lookup
     * @param {number} maintenanceID ID of maintenance to retrieve. Optional:
     * when omitted (legacy single-arg form) the argument above is treated as
     * the maintenanceID and the deprecated global registry is read instead.
     * @returns {(object|null)} Maintenance if it exists in that tenant
     */
    getMaintenance(tenantId, maintenanceID) {
        // Legacy single-arg form: getMaintenance(maintenanceID)
        if (maintenanceID === undefined) {
            return this.maintenanceList[tenantId] || null;
        }
        const tenantList = this.maintenanceListByTenant[tenantId];
        if (tenantList && tenantList[maintenanceID]) {
            return tenantList[maintenanceID];
        }
        return null;
    }

    /**
     * Retrieve a specific maintenance scoped to the caller's active tenant
     * (G4.21). Reads only the tenant-partitioned map, so a user belonging to
     * multiple tenants can never fetch (and then pause/edit/resume) their own
     * row living in another tenant — the legacy flat map is keyed by id alone
     * and guarded by nothing, which G4.20's IDOR suite flagged.
     *
     * Returns the live in-memory bean (with its Croner job attached), so
     * pause/edit/resume keep controlling the running schedule like before.
     * @param {number} maintenanceID ID of maintenance to retrieve
     * @param {number} tenantID Active tenant of the caller (socket.tenantID)
     * @returns {(object|null)} Maintenance if it exists in that tenant
     */
    getMaintenanceForTenant(maintenanceID, tenantID) {
        const tenantList = this.maintenanceListByTenant[tenantID];
        if (tenantList && tenantList[maintenanceID]) {
            return tenantList[maintenanceID];
        }
        return null;
    }

    /**
     * Write error to log file
     * @param {any} error The error to write
     * @param {boolean} outputToConsole Should the error also be output to console?
     * @returns {void}
     */
    static errorLog(error, outputToConsole = true) {
        const errorLogStream = fs.createWriteStream(path.join(Database.dataDir, "/error.log"), {
            flags: "a",
        });

        errorLogStream.on("error", () => {
            log.info("", "Cannot write to error.log");
        });

        if (errorLogStream) {
            const dateTime = R.isoDateTime();
            errorLogStream.write(`[${dateTime}] ` + util.format(error) + "\n");

            if (outputToConsole) {
                console.error(error);
            }
        }

        errorLogStream.end();
    }

    /**
     * Get the IP of the client connected to the socket
     * @param {Socket} socket Socket to query
     * @returns {Promise<string>} IP of client
     */
    getClientIP(socket) {
        return this.getClientIPwithProxy(socket.client.conn.remoteAddress, socket.client.conn.request.headers);
    }

    /**
     * @param {string} clientIP Raw client IP
     * @param {IncomingHttpHeaders} headers HTTP headers
     * @returns {Promise<string>} Client IP with proxy (if trusted)
     */
    async getClientIPwithProxy(clientIP, headers) {
        if (clientIP === undefined) {
            clientIP = "";
        }

        if (await Settings.get("trustProxy")) {
            const forwardedFor = headers["x-forwarded-for"];

            return (
                (typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : null) ||
                headers["x-real-ip"] ||
                clientIP.replace(/^::ffff:/, "")
            );
        } else {
            return clientIP.replace(/^::ffff:/, "");
        }
    }

    /**
     * Attempt to get the current server timezone
     * If this fails, fall back to environment variables and then make a
     * guess.
     * @returns {Promise<string>} Current timezone
     */
    async getTimezone() {
        // From process.env.TZ
        try {
            if (process.env.TZ) {
                this.checkTimezone(process.env.TZ);
                return process.env.TZ;
            }
        } catch (e) {
            log.warn("timezone", e.message + " in process.env.TZ");
        }

        let timezone = await Settings.get("serverTimezone");

        // From Settings
        try {
            log.debug("timezone", "Using timezone from settings: " + timezone);
            if (timezone) {
                this.checkTimezone(timezone);
                return timezone;
            }
        } catch (e) {
            log.warn("timezone", e.message + " in settings");
        }

        // Guess
        try {
            let guess = dayjs.tz.guess();
            log.debug("timezone", "Guessing timezone: " + guess);
            if (guess) {
                this.checkTimezone(guess);
                return guess;
            } else {
                return "UTC";
            }
        } catch (e) {
            // Guess failed, fall back to UTC
            log.debug("timezone", "Guessed an invalid timezone. Use UTC as fallback");
            return "UTC";
        }
    }

    /**
     * Get the current offset
     * @returns {string} Time offset
     */
    getTimezoneOffset() {
        return dayjs().format("Z");
    }

    /**
     * Throw an error if the timezone is invalid
     * @param {string} timezone Timezone to test
     * @returns {void}
     * @throws The timezone is invalid
     */
    checkTimezone(timezone) {
        try {
            dayjs.utc("2013-11-18 11:55").tz(timezone).format();
        } catch (e) {
            throw new Error("Invalid timezone:" + timezone);
        }
    }

    /**
     * Set the current server timezone and environment variables
     * @param {string} timezone Timezone to set
     * @returns {Promise<void>}
     */
    async setTimezone(timezone) {
        this.checkTimezone(timezone);
        await Settings.set("serverTimezone", timezone, "general");
        process.env.TZ = timezone;
        dayjs.tz.setDefault(timezone);
    }

    /**
     * TODO: Listen logic should be moved to here
     * @returns {Promise<void>}
     */
    async start() {
        let enable = await Settings.get("nscd");

        if (enable || enable === null) {
            await this.startNSCDServices();
        }
    }

    /**
     * Stop the server
     * @returns {Promise<void>}
     */
    async stop() {
        // G2 task-12: stop the force-logout watchdog so no tick fires during
        // or after shutdown (mid-tick shutdown safety, task-12 lifecycle
        // contract). Always safe when the job was never started.
        try {
            stopTenantMembershipCheckJob(this.tenantCheckToken);
            this.tenantCheckToken = null;
        } catch (e) {
            log.error("server", `Failed to stop tenant membership check job: ${e.message}`);
        }

        let enable = await Settings.get("nscd");

        if (enable || enable === null) {
            await this.stopNSCDServices();
        }
    }

    /**
     * Start all system services (e.g. nscd)
     * For now, only used in Docker
     * @returns {void}
     */
    async startNSCDServices() {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            try {
                log.info("services", "Starting nscd");
                await childProcessAsync.exec("sudo service nscd start");
            } catch (e) {
                log.info("services", "Failed to start nscd");
            }
        }
    }

    /**
     * Stop all system services
     * @returns {void}
     */
    async stopNSCDServices() {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            try {
                log.info("services", "Stopping nscd");
                await childProcessAsync.exec("sudo service nscd stop");
            } catch (e) {
                log.info("services", "Failed to stop nscd");
            }
        }
    }

    /**
     * Default User-Agent when making HTTP requests
     * @returns {string} User-Agent
     */
    getUserAgent() {
        return "Uptime-Kuma/" + require("../package.json").version;
    }

    /**
     * Force connected sockets of a user to refresh and disconnect.
     * Used for resetting password.
     * @param {string} userID User ID
     * @param {string?} currentSocketID Current socket ID
     * @returns {void}
     */
    disconnectAllSocketClients(userID, currentSocketID = undefined) {
        for (const socket of this.io.sockets.sockets.values()) {
            if (socket.userID === userID && socket.id !== currentSocketID) {
                try {
                    socket.emit("refresh");
                    socket.disconnect();
                } catch (e) {}
            }
        }
    }

    /**
     * Force connected sockets of a user to refresh and disconnect, but only
     * within a single tenant. Used when a user is removed from a tenant
     * (G2.12 force-logout): their sessions in other tenants stay alive,
     * unlike password reset which invalidates every session cross-tenant
     * via disconnectAllSocketClients().
     * Targets sockets joined to the user room key from
     * server/socket-handlers/tenant-room.js (`t${tenantId}:u${userId}`);
     * before G2.11 room wiring lands this matches nothing and is a no-op.
     *
     * ID contract (G2.11, CTO pre-review KUM-82): `userID` and `tenantId`
     * MUST be the numeric database ids — the same values sockets carry as
     * `socket.userID = user.id` (afterLogin) and `socket.tenantID`. The
     * strict-equality checks below and the room-key validators both assume
     * numbers; passing an opaque/UUID string would never match a socket and
     * userRoom() throws on non-numeric ids, so G2.12 call sites must pass
     * the removed membership's numeric user.id.
     * @param {number} tenantId Tenant id
     * @param {number} userID Numeric user id (user.id, not an opaque string)
     * @param {string?} currentSocketID Current socket ID to keep alive
     * @returns {void}
     */
    disconnectAllSocketClientsForTenant(tenantId, userID, currentSocketID = undefined) {
        const userRoomKey = userRoom(tenantId, userID);
        for (const socket of this.io.sockets.sockets.values()) {
            if (
                socket.tenantID === tenantId
                && socket.userID === userID
                && socket.rooms.has(userRoomKey)
                && socket.id !== currentSocketID
            ) {
                try {
                    socket.emit("refresh");
                    socket.disconnect();
                } catch (e) {}
            }
        }
    }
}

module.exports = {
    UptimeKumaServer,
};

// Must be at the end to avoid circular dependencies
const { RealBrowserMonitorType } = require("./monitor-types/real-browser-monitor-type");
const { TailscalePing } = require("./monitor-types/tailscale-ping");
const { WebSocketMonitorType } = require("./monitor-types/websocket-upgrade");
const { DnsMonitorType } = require("./monitor-types/dns");
const { PostgresMonitorType } = require("./monitor-types/postgres");
const { MqttMonitorType } = require("./monitor-types/mqtt");
const { SMTPMonitorType } = require("./monitor-types/smtp");
const { GroupMonitorType } = require("./monitor-types/group");
const { SNMPMonitorType } = require("./monitor-types/snmp");
const { GrpcKeywordMonitorType } = require("./monitor-types/grpc");
const { MongodbMonitorType } = require("./monitor-types/mongodb");
const { RabbitMqMonitorType } = require("./monitor-types/rabbitmq");
const { SIPMonitorType } = require("./monitor-types/sip-options");
const { GameDigMonitorType } = require("./monitor-types/gamedig");
const { SteamMonitorType } = require("./monitor-types/steam");
const { TCPMonitorType } = require("./monitor-types/tcp.js");
const { ManualMonitorType } = require("./monitor-types/manual");
const { GlobalpingMonitorType } = require("./monitor-types/globalping");
const { RedisMonitorType } = require("./monitor-types/redis");
const { PM2MonitorType } = require("./monitor-types/pm2");
const { SystemServiceMonitorType } = require("./monitor-types/system-service");
const { MssqlMonitorType } = require("./monitor-types/mssql");
const { MysqlMonitorType } = require("./monitor-types/mysql");
const { OracleDbMonitorType } = require("./monitor-types/oracledb");
const { NTPMonitorType } = require("./monitor-types/ntp");
const Monitor = require("./model/monitor");
